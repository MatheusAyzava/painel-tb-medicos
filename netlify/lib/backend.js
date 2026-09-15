const crypto = require("crypto");

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body, (_, value) => (typeof value === "bigint" ? Number(value) : value)),
  };
}

function toNumber(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return value;
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function pemFromEnv() {
  let raw = process.env.SNOWFLAKE_PRIVATE_KEY || "";
  raw = raw.replace(/\\n/g, "\n").trim();
  if (!raw) throw new Error("SNOWFLAKE_PRIVATE_KEY não configurada no Netlify.");
  if (!raw.includes("BEGIN")) {
    raw = `-----BEGIN PRIVATE KEY-----\n${raw}\n-----END PRIVATE KEY-----`;
  }
  return raw;
}

function snowflakeFingerprint(pem) {
  const privateKey = crypto.createPrivateKey(pem);
  const publicKey = crypto.createPublicKey(privateKey);
  const der = publicKey.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("base64");
}

function snowflakeJwt() {
  const pem = pemFromEnv();
  const account = (process.env.SNOWFLAKE_ACCOUNT || "").replace(/\.snowflakecomputing\.com$/i, "").toUpperCase();
  const user = (process.env.SNOWFLAKE_USER || "").toUpperCase();
  if (!account || !user) throw new Error("SNOWFLAKE_ACCOUNT / SNOWFLAKE_USER ausentes.");
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: `${account}.${user}.SHA256:${snowflakeFingerprint(pem)}`,
    sub: `${account}.${user}`,
    iat: now,
    exp: now + 55 * 60,
  };
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const data = `${header}.${body}`;
  const sig = crypto.sign("sha256", Buffer.from(data), {
    key: pem,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  });
  return { token: `${data}.${sig.toString("base64url")}`, account };
}

async function snowflakeSql(sql) {
  const { token, account } = snowflakeJwt();
  const base = `https://${account.toLowerCase()}.snowflakecomputing.com/api/v2/statements`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  let res = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify({
      statement: sql,
      timeout: 60,
      database: process.env.SNOWFLAKE_DATABASE || "DADOSFERA_PRD_DIGITALSOLVERS",
      schema: "GOLD",
      warehouse: process.env.SNOWFLAKE_WAREHOUSE || "COMPUTE_WH",
    }),
  });
  let data = await res.json().catch(() => ({}));
  const started = Date.now();
  while (
    (res.status === 202 || data.code === "333334") &&
    data.statementHandle &&
    Date.now() - started < 50000
  ) {
    await new Promise((r) => setTimeout(r, 900));
    res = await fetch(`${base}/${data.statementHandle}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
        Accept: "application/json",
      },
    });
    data = await res.json().catch(() => ({}));
  }
  if (!Array.isArray(data.data)) {
    throw new Error(data.message || data.error || `Snowflake HTTP ${res.status}`);
  }
  return data.data;
}

async function querySnowflake() {
  const kpis = (await snowflakeSql(`
    SELECT
      (SELECT COUNT(DISTINCT UF_CRM) FROM GOLD.TB_MEDICOS WHERE UPPER(SITUACAO) = 'ATIVO') AS CRM_UNICOS,
      (SELECT COUNT(DISTINCT CPF) FROM GOLD.TB_MEDICOS WHERE UPPER(SITUACAO) = 'ATIVO') AS CPF_UNICOS,
      (SELECT COUNT(*) FROM GOLD.TB_MEDICOS WHERE UPPER(SITUACAO) = 'ATIVO') AS TOTAL_MEDICOS,
      (SELECT COUNT(DISTINCT UF_CRM) FROM GOLD.TB_MEDICOS) AS TOTAL_REGISTROS,
      (SELECT MAX(UPDATE_DATE) FROM GOLD.TB_MEDICOS) AS ATUALIZADO_GOLD,
      (SELECT MAX(UPDATE_DATE) FROM SILVER.TB_CFM) AS ATUALIZADO_CFM,
      (SELECT COUNT(DISTINCT ESPECIALIDADE) FROM GOLD.TB_ESPECIALIDADE_X_FONTES) AS ESPECIALIDADES
  `))[0] || [];

  const crm = toNumber(kpis[0]);
  const extras = [
    { label: "CRMs únicos ativos", value: crm, accent: true },
    { label: "CPFs únicos ativos", value: toNumber(kpis[1]) },
    { label: "Total médicos ativos", value: toNumber(kpis[2]) },
    { label: "Total registros (todas situações)", value: toNumber(kpis[3]) },
  ];
  const especialidades = toNumber(kpis[6]);
  if (especialidades) extras.push({ label: "Especialidades", value: especialidades });

  const [ufs, genero, tipo] = await Promise.all([
    snowflakeSql(`
      SELECT UF, COUNT(DISTINCT UF_CRM) AS N
      FROM GOLD.TB_MEDICOS
      WHERE UPPER(SITUACAO) = 'ATIVO'
      GROUP BY UF
      ORDER BY N DESC
      LIMIT 12
    `),
    snowflakeSql(`
      SELECT COALESCE(GENERO, 'Não informado') AS GENERO, COUNT(*) AS QTD_MEDICOS
      FROM GOLD.TB_MEDICOS
      WHERE UPPER(SITUACAO) = 'ATIVO'
      GROUP BY GENERO
      ORDER BY QTD_MEDICOS DESC
    `),
    snowflakeSql(`
      SELECT TIPO_INSCRICAO, COUNT(*) AS QTD_MEDICOS
      FROM GOLD.TB_MEDICOS
      WHERE UPPER(SITUACAO) = 'ATIVO'
      GROUP BY TIPO_INSCRICAO
      ORDER BY QTD_MEDICOS DESC
    `),
  ]);

  return {
    valor: crm,
    crm_unicos: crm,
    cpf_unicos: toNumber(kpis[1]),
    total_medicos: toNumber(kpis[2]),
    total_registros: toNumber(kpis[3]),
    especialidades,
    fonte: "dadosfera",
    tabela: "DADOSFERA_PRD_DIGITALSOLVERS.GOLD.TB_MEDICOS",
    ufs: ufs.filter((r) => r && r[0] != null).map((r) => ({ uf: String(r[0]), value: toNumber(r[1]) })),
    genero: genero.map((r) => ({ label: String(r[0] || "Não informado"), value: toNumber(r[1]) })),
    tipo_inscricao: tipo.map((r) => ({ label: String(r[0] || "Other"), value: toNumber(r[1]) })),
    extras,
    atualizado_em: kpis[4],
    atualizado_cnes: kpis[4],
    atualizado_cfm: kpis[5],
  };
}

async function databricksSql(sql) {
  const host = (process.env.DATABRICKS_HOST || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const token = process.env.DATABRICKS_TOKEN || "";
  const warehouseId = process.env.DATABRICKS_WAREHOUSE_ID || "";
  if (!host || !token || !warehouseId) throw new Error("DATABRICKS_HOST / TOKEN / WAREHOUSE_ID ausentes no Netlify.");
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  let res = await fetch(`https://${host}/api/2.0/sql/statements`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      warehouse_id: warehouseId,
      statement: sql,
      wait_timeout: "25s",
      on_wait_timeout: "CONTINUE",
      disposition: "INLINE",
    }),
  });
  let data = await res.json().catch(() => ({}));
  const started = Date.now();
  while (["PENDING", "RUNNING"].includes((data.status || {}).state) && Date.now() - started < 50000) {
    await new Promise((r) => setTimeout(r, 1200));
    res = await fetch(`https://${host}/api/2.0/sql/statements/${data.statement_id}`, { headers });
    data = await res.json().catch(() => ({}));
  }
  if ((data.status || {}).state === "FAILED") {
    throw new Error(((data.status || {}).error || {}).message || "Query Databricks falhou");
  }
  return ((data.result || {}).data_array) || [];
}

async function queryDatabricks() {
  const catalog = process.env.DATABRICKS_CATALOG || "dev";
  const table = `${catalog}.gold.${process.env.DATABRICKS_TABLE || "tb_medicos"}`;
  const kpis = (await databricksSql(`
    SELECT
      COUNT(DISTINCT CASE WHEN UPPER(situacao) = 'ATIVO' THEN uf_crm END),
      COUNT(DISTINCT CASE WHEN UPPER(situacao) = 'ATIVO' THEN cpf END),
      COUNT(CASE WHEN UPPER(situacao) = 'ATIVO' THEN 1 END),
      COUNT(DISTINCT uf_crm),
      MAX(update_date)
    FROM ${table}
  `))[0] || [];

  const crm = toNumber(kpis[0]);
  let bronze = 0;
  let silver = 0;
  try {
    bronze = toNumber(((await databricksSql(`
      SELECT COUNT(DISTINCT regexp_replace(cpf, '[^0-9]', ''))
      FROM ${catalog}.bronze.db_d2p_43_cnes_profissionais
      WHERE cbo LIKE '225%'
    `))[0] || [])[0]);
  } catch {
    bronze = 0;
  }
  try {
    silver = toNumber(((await databricksSql(`
      SELECT COUNT(DISTINCT regexp_replace(cpf, '[^0-9]', ''))
      FROM ${catalog}.silver.tb_cnes_profissionais
      WHERE cbo LIKE '225%'
    `))[0] || [])[0]);
  } catch {
    silver = 0;
  }

  const extras = [
    { label: "Databricks · CRMs únicos ativos", value: crm, accent: true },
    { label: "Databricks · CPFs únicos ativos", value: toNumber(kpis[1]) },
    { label: "Databricks · Total médicos ativos", value: toNumber(kpis[2]) },
    { label: "Databricks · Total registros", value: toNumber(kpis[3]) },
  ];
  if (bronze) extras.push({ label: "Databricks · Bronze CNES", value: bronze });
  if (silver) extras.push({ label: "Databricks · Silver CNES", value: silver });

  return {
    valor: crm,
    crm_unicos: crm,
    cpf_unicos: toNumber(kpis[1]),
    total_medicos: toNumber(kpis[2]),
    total_registros: toNumber(kpis[3]),
    bronze,
    silver,
    fonte: "databricks",
    tabela: table,
    extras,
    atualizado_em: kpis[4],
    atualizado_cfm: kpis[4],
    atualizado_cnes: kpis[4],
  };
}

function loadSnapshot() {
  return require("../../assets/snapshot.json");
}

function queryCnes() {
  const snap = loadSnapshot();
  const manual = (snap.fontes || {}).manual || {};
  return {
    valor: manual.bronze || 0,
    fonte: "manual",
    atualizado_em: manual.atualizado_em,
    arquivo: "TOTAL.zip (última carga)",
    extras: manual.extras || [],
  };
}

function statusPayload() {
  const catalog = process.env.DATABRICKS_CATALOG || "dev";
  const table = process.env.DATABRICKS_TABLE || "tb_medicos";
  const snap = loadSnapshot();
  return {
    snowflake: {
      ok: Boolean(process.env.SNOWFLAKE_PRIVATE_KEY && process.env.SNOWFLAKE_ACCOUNT),
      account: process.env.SNOWFLAKE_ACCOUNT || "",
      warehouse: process.env.SNOWFLAKE_WAREHOUSE || "COMPUTE_WH",
    },
    databricks: {
      ok: Boolean(process.env.DATABRICKS_TOKEN && process.env.DATABRICKS_HOST),
      host: process.env.DATABRICKS_HOST ? "Databricks API" : "",
      warehouse_id: process.env.DATABRICKS_WAREHOUSE_ID ? "configurado" : "",
      tabela: `${catalog}.gold.${table}`,
    },
    cnes: {
      ok: true,
      last: queryCnes(),
      pasta: "Netlify · TXT da última carga",
    },
    live: true,
    snapshot: snap,
  };
}

module.exports = {
  json,
  querySnowflake,
  queryDatabricks,
  queryCnes,
  statusPayload,
};
