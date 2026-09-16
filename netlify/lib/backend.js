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

function snowflakeStamp(value) {
  if (value == null || value === "") return "";
  if (typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value).trim())) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 1e9) {
      const ms = n >= 1e18 ? n / 1e6 : n >= 1e14 ? n / 1e3 : n >= 1e12 ? n : n * 1000;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) {
        const p = (x) => String(x).padStart(2, "0");
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      }
    }
  }
  return String(value);
}

function toNumber(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return value;
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function rebuildPem(type, body) {
  const lines = String(body).match(/.{1,64}/g) || [];
  return `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----`;
}

function extractKeyBody(raw) {
  let text = String(raw || "").replace(/^\uFEFF/, "").replace(/\r/g, "").trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  text = text.replace(/\\n/g, "\n").trim();
  const block = text.match(/-----BEGIN [A-Z0-9 ]+-----([\s\S]*?)-----END [A-Z0-9 ]+-----/);
  const body = block
    ? block[1]
    : text.replace(/-----BEGIN [A-Z0-9 ]+-----/g, "").replace(/-----END [A-Z0-9 ]+-----/g, "");
  return body.replace(/[^A-Za-z0-9+/=]/g, "");
}

function loadPrivateKey() {
  const raw = process.env.SNOWFLAKE_PRIVATE_KEY || "";
  if (!raw.trim()) throw new Error("SNOWFLAKE_PRIVATE_KEY não configurada no Netlify.");
  const body = extractKeyBody(raw);
  if (!body) throw new Error("SNOWFLAKE_PRIVATE_KEY está vazia ou inválida.");
  const der = Buffer.from(body, "base64");
  const passphrase = process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE || process.env.SNOWFLAKE_PASSPHRASE || "";
  const attempts = [
    { key: der, format: "der", type: "pkcs8" },
    { key: der, format: "der", type: "pkcs1" },
    { key: rebuildPem("PRIVATE KEY", body), format: "pem" },
    { key: rebuildPem("RSA PRIVATE KEY", body), format: "pem" },
  ];
  if (passphrase) {
    attempts.push(
      { key: rebuildPem("ENCRYPTED PRIVATE KEY", body), format: "pem", passphrase },
      { key: rebuildPem("PRIVATE KEY", body), format: "pem", passphrase },
      { key: rebuildPem("RSA PRIVATE KEY", body), format: "pem", passphrase },
    );
  }
  for (const opts of attempts) {
    try {
      return crypto.createPrivateKey(opts);
    } catch {
      /* tenta o próximo formato */
    }
  }
  throw new Error("Chave RSA do Snowflake ilegível. No Netlify, use PEM PKCS#8 (BEGIN PRIVATE KEY) em SNOWFLAKE_PRIVATE_KEY.");
}

function snowflakeFingerprint(key) {
  const der = crypto.createPublicKey(key).export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("base64");
}

function snowflakeJwt() {
  const key = loadPrivateKey();
  const account = (process.env.SNOWFLAKE_ACCOUNT || "").replace(/\.snowflakecomputing\.com$/i, "").toUpperCase();
  const user = (process.env.SNOWFLAKE_USER || "").toUpperCase();
  if (!account || !user) throw new Error("SNOWFLAKE_ACCOUNT / SNOWFLAKE_USER ausentes.");
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: `${account}.${user}.SHA256:${snowflakeFingerprint(key)}`,
    sub: `${account}.${user}`,
    iat: now,
    exp: now + 55 * 60,
  };
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const data = `${header}.${body}`;
  const sig = crypto.sign("sha256", Buffer.from(data), {
    key,
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
      (SELECT TO_CHAR(MAX(UPDATE_DATE), 'YYYY-MM-DD HH24:MI:SS') FROM GOLD.TB_MEDICOS) AS ATUALIZADO_GOLD,
      (SELECT TO_CHAR(MAX(UPDATE_DATE), 'YYYY-MM-DD HH24:MI:SS') FROM SILVER.TB_CFM) AS ATUALIZADO_CFM,
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
    atualizado_em: snowflakeStamp(kpis[4]),
    atualizado_cnes: snowflakeStamp(kpis[4]),
    atualizado_cfm: snowflakeStamp(kpis[5]),
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

function labelRows(rows) {
  return (rows || []).filter((r) => r).map((r) => ({ label: String(r[0] || "Não informado"), value: toNumber(r[1]) }));
}

const UF_REGIAO = {
  AC: "Norte", AP: "Norte", AM: "Norte", PA: "Norte", RO: "Norte", RR: "Norte", TO: "Norte",
  AL: "Nordeste", BA: "Nordeste", CE: "Nordeste", MA: "Nordeste", PB: "Nordeste",
  PE: "Nordeste", PI: "Nordeste", RN: "Nordeste", SE: "Nordeste",
  ES: "Sudeste", MG: "Sudeste", RJ: "Sudeste", SP: "Sudeste",
  PR: "Sul", RS: "Sul", SC: "Sul",
  DF: "Centro-Oeste", GO: "Centro-Oeste", MS: "Centro-Oeste", MT: "Centro-Oeste",
};

async function queryDadosferaBi() {
  const kpis = (await snowflakeSql(`
    SELECT
      (SELECT COUNT(DISTINCT UF_CRM) FROM GOLD.TB_MEDICOS WHERE UPPER(SITUACAO) = 'ATIVO'),
      (SELECT COUNT(DISTINCT CPF) FROM GOLD.TB_MEDICOS WHERE UPPER(SITUACAO) = 'ATIVO'),
      (SELECT COUNT(DISTINCT ESPECIALIDADE) FROM GOLD.TB_ESPECIALIDADE_X_FONTES),
      (SELECT TO_CHAR(MAX(UPDATE_DATE), 'YYYY-MM-DD HH24:MI:SS') FROM GOLD.TB_MEDICOS)
  `))[0] || [];

  const [genero, faixa, especialidadeDs, especialidadeCfm, ufsRaw, mensal, cidadesRaw] = await Promise.all([
    snowflakeSql(`
      SELECT COALESCE(GENERO, 'Não informado'), COUNT(*)
      FROM GOLD.TB_MEDICOS
      WHERE UPPER(SITUACAO) = 'ATIVO'
      GROUP BY 1 ORDER BY 2 DESC
    `),
    snowflakeSql(`
      SELECT COALESCE(FAIXA_ETARIA, 'Não definida'), COUNT(DISTINCT UF_CRM)
      FROM GOLD.TB_ESPECIALIDADE_X_FONTES
      WHERE UPPER(SITUACAO) = 'ATIVO'
      GROUP BY 1 ORDER BY 2 DESC
    `),
    snowflakeSql(`
      SELECT COALESCE(NULLIF(ESPECIALIDADE, ''), 'SEM ESPECIALIDADE'), COUNT(DISTINCT UF_CRM)
      FROM GOLD.TB_ESPECIALIDADE_X_FONTES
      WHERE UPPER(SITUACAO) = 'ATIVO'
      GROUP BY 1 ORDER BY 2 DESC LIMIT 12
    `),
    snowflakeSql(`
      SELECT COALESCE(NULLIF(ESPECIALIDADE_RQE, ''), 'SEM ESPECIALIDADE'), COUNT(DISTINCT UF_CRM)
      FROM GOLD.TB_ESPECIALIDADE_X_FONTES
      WHERE UPPER(SITUACAO) = 'ATIVO'
      GROUP BY 1 ORDER BY 2 DESC LIMIT 12
    `),
    snowflakeSql(`
      SELECT UF, COUNT(DISTINCT UF_CRM) N
      FROM GOLD.TB_MEDICOS
      WHERE UPPER(SITUACAO) = 'ATIVO' AND UF IS NOT NULL
      GROUP BY UF ORDER BY N DESC
    `),
    snowflakeSql(`
      SELECT TO_CHAR(DATE_TRUNC('MONTH', COALESCE(
               TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'),
               TRY_TO_DATE(DT_INSCRICAO)
             )), 'YYYY-MM') M,
             COUNT(DISTINCT UF_CRM) N
      FROM GOLD.TB_ESPECIALIDADE_X_FONTES
      WHERE COALESCE(TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(DT_INSCRICAO))
              >= DATEADD(MONTH, -35, DATE_TRUNC('MONTH', CURRENT_DATE()))
        AND COALESCE(TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(DT_INSCRICAO))
              < DATEADD(MONTH, 1, DATE_TRUNC('MONTH', CURRENT_DATE()))
        AND YEAR(COALESCE(TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(DT_INSCRICAO)))
              BETWEEN 2000 AND YEAR(CURRENT_DATE())
      GROUP BY 1 ORDER BY 1
    `),
    snowflakeSql(`
      SELECT UF, MUNICIPIO, IBGE, N FROM (
        SELECT UF, MUNICIPIO, IBGE, N,
               ROW_NUMBER() OVER (PARTITION BY UF ORDER BY N DESC) RN
        FROM (
          SELECT UF, MUNICIPIO, IBGE, COUNT(DISTINCT COALESCE(NULLIF(UF_CRM, ''), CPF)) N
          FROM GOLD.TB_CNES_PROFISSIONAIS
          WHERE CBO LIKE '225%' AND MUNICIPIO IS NOT NULL
          GROUP BY 1,2,3
        )
      )
      WHERE RN <= 40 OR UF = 'SP'
      ORDER BY N DESC
    `),
  ]);

  const ufs = ufsRaw.filter((r) => r && r[0]).map((r) => ({ uf: String(r[0]), value: toNumber(r[1]) }));
  const regioes = {};
  ufs.forEach((item) => {
    const key = UF_REGIAO[item.uf] || "Outros";
    regioes[key] = (regioes[key] || 0) + item.value;
  });
  return {
    fonte: "dadosfera",
    crm: toNumber(kpis[0]),
    medicos: toNumber(kpis[1]),
    especialidades: toNumber(kpis[2]),
    atualizado_em: snowflakeStamp(kpis[3]),
    genero: labelRows(genero),
    faixa: labelRows(faixa),
    especialidade_ds: labelRows(especialidadeDs),
    especialidade_cfm: labelRows(especialidadeCfm),
    ufs,
    regioes: Object.entries(regioes).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
    mensal: (mensal || []).filter((r) => r && r[0]).map((r) => ({ mes: String(r[0]), value: toNumber(r[1]) })).filter((m) => {
      const y = Number(String(m.mes).slice(0, 4));
      const mo = Number(String(m.mes).slice(5, 7));
      const now = new Date();
      return /^\d{4}-\d{2}$/.test(m.mes) && y >= 2000 && y <= now.getFullYear() && mo >= 1 && mo <= 12
        && y * 100 + mo <= now.getFullYear() * 100 + (now.getMonth() + 1);
    }),
    cidades: (cidadesRaw || []).map((r) => ({
      uf: String(r[0] || ""),
      municipio: String(r[1] || ""),
      ibge: String(r[2] || ""),
      value: toNumber(r[3]),
    })),
  };
}

async function queryMedicosNovos(opts = {}) {
  const modo = String(opts.modo || "").toLowerCase() === "todos" ? "todos" : "novos";
  const ok = /^\d{4}-\d{2}$/.test(String(opts.mes || ""));
  const stamp = ok ? String(opts.mes) : new Date().toISOString().slice(0, 7);
  const [ano, mo] = stamp.split("-").map(Number);
  const uf = String(opts.uf || "").replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 2);
  const municipio = String(opts.municipio || "").replace(/[^A-Za-zÀ-ÿ0-9 .\-']/g, "").slice(0, 80);
  let ibge = String(opts.ibge || "").replace(/\D/g, "");
  if (ibge) ibge = ibge.padStart(7, "0");
  if (modo === "todos" && !uf && !municipio && !ibge) {
    return { modo, mes: stamp, total: 0, linhas: [], aviso: "Clique numa cidade no mapa para listar os médicos." };
  }

  let cityFilter = "";
  if (uf) cityFilter += ` AND p.UF = '${uf}'`;
  if (ibge) cityFilter += ` AND LPAD(REGEXP_REPLACE(TO_VARCHAR(p.IBGE), '[^0-9]', ''), 7, '0') = '${ibge}'`;
  else if (municipio) cityFilter += ` AND UPPER(p.MUNICIPIO) = UPPER('${municipio.replace(/'/g, "''")}')`;

  const dateFilter = modo === "novos"
    ? `AND b.DT_NOVO >= DATE_FROM_PARTS(${ano}, ${mo}, 1) AND b.DT_NOVO < DATEADD(MONTH, 1, DATE_FROM_PARTS(${ano}, ${mo}, 1))`
    : "";
  const joinBase = modo === "novos" ? "JOIN" : "LEFT JOIN";
  const telJoin = `
    LEFT JOIN (
      SELECT UF_CRM, TELEFONE FROM GOLD.TB_MEDICOS_TELEFONES_FREQUENCIA
      QUALIFY ROW_NUMBER() OVER (PARTITION BY UF_CRM ORDER BY QTDE_REPETICOES DESC NULLS LAST) = 1
    ) tel ON tel.UF_CRM = m.UF_CRM
    LEFT JOIN (
      SELECT UF_CRM, EMAIL FROM GOLD.TB_MEDICOS_EMAILS_FREQUENCIA
      QUALIFY ROW_NUMBER() OVER (PARTITION BY UF_CRM ORDER BY QTDE_REPETICOES DESC NULLS LAST) = 1
    ) em ON em.UF_CRM = m.UF_CRM`;

  const sql = cityFilter ? `
    WITH cid AS (
      SELECT UF_CRM, MUNICIPIO, UF, IBGE
      FROM GOLD.TB_CNES_PROFISSIONAIS p
      WHERE CBO LIKE '225%' AND NULLIF(UF_CRM, '') IS NOT NULL AND MUNICIPIO IS NOT NULL
        ${cityFilter}
      QUALIFY ROW_NUMBER() OVER (PARTITION BY UF_CRM ORDER BY UPDATE_DATE DESC NULLS LAST) = 1
    ),
    base AS (
      SELECT UF_CRM,
             MIN(COALESCE(TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(DT_INSCRICAO))) AS DT_NOVO,
             MIN(COALESCE(NULLIF(ESPECIALIDADE, ''), NULLIF(ESPECIALIDADE_RQE, ''), 'SEM ESPECIALIDADE')) AS ESPECIALIDADE
      FROM GOLD.TB_ESPECIALIDADE_X_FONTES GROUP BY UF_CRM
    )
    SELECT m.UF_CRM, m.NOME, c.MUNICIPIO, COALESCE(c.UF, m.UF), tel.TELEFONE, em.EMAIL, TO_CHAR(b.DT_NOVO, 'YYYY-MM-DD'), b.ESPECIALIDADE
    FROM GOLD.TB_MEDICOS m
    JOIN cid c ON c.UF_CRM = m.UF_CRM
    ${joinBase} base b ON b.UF_CRM = m.UF_CRM
    ${telJoin}
    WHERE UPPER(m.SITUACAO) = 'ATIVO' ${dateFilter}
    ORDER BY m.NOME LIMIT 8000
  ` : `
    WITH base AS (
      SELECT UF_CRM,
             MIN(COALESCE(TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(DT_INSCRICAO))) AS DT_NOVO,
             MIN(COALESCE(NULLIF(ESPECIALIDADE, ''), NULLIF(ESPECIALIDADE_RQE, ''), 'SEM ESPECIALIDADE')) AS ESPECIALIDADE
      FROM GOLD.TB_ESPECIALIDADE_X_FONTES GROUP BY UF_CRM
    )
    SELECT m.UF_CRM, m.NOME, NULL, m.UF, tel.TELEFONE, em.EMAIL, TO_CHAR(b.DT_NOVO, 'YYYY-MM-DD'), b.ESPECIALIDADE
    FROM GOLD.TB_MEDICOS m
    JOIN base b ON b.UF_CRM = m.UF_CRM
    ${telJoin}
    WHERE UPPER(m.SITUACAO) = 'ATIVO' ${dateFilter}
    ORDER BY m.NOME LIMIT 8000
  `;

  const rows = await snowflakeSql(sql);
  const lista = (rows || []).map((r) => ({
    uf_crm: String(r[0] || ""),
    nome: String(r[1] || ""),
    cidade: String(r[2] || ""),
    uf: String(r[3] || ""),
    telefone: String(r[4] || ""),
    email: String(r[5] || ""),
    data: String(r[6] || ""),
    especialidade: String(r[7] || ""),
  }));
  return { modo, mes: stamp, uf, municipio, ibge, total: lista.length, linhas: lista };
}

async function queryCidadesNovos(opts = {}) {
  const ok = /^\d{4}-\d{2}$/.test(String(opts.mes || ""));
  const stamp = ok ? String(opts.mes) : new Date().toISOString().slice(0, 7);
  const [ano, mo] = stamp.split("-").map(Number);
  const rows = await snowflakeSql(`
    WITH cid AS (
      SELECT UF_CRM, MUNICIPIO, UF, IBGE
      FROM GOLD.TB_CNES_PROFISSIONAIS p
      WHERE CBO LIKE '225%' AND NULLIF(UF_CRM, '') IS NOT NULL AND MUNICIPIO IS NOT NULL
      QUALIFY ROW_NUMBER() OVER (PARTITION BY UF_CRM ORDER BY UPDATE_DATE DESC NULLS LAST) = 1
    ),
    base AS (
      SELECT UF_CRM, MIN(COALESCE(TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(DT_INSCRICAO))) AS DT_NOVO
      FROM GOLD.TB_ESPECIALIDADE_X_FONTES GROUP BY UF_CRM
    )
    SELECT c.UF, c.MUNICIPIO, c.IBGE, COUNT(DISTINCT m.UF_CRM) N
    FROM GOLD.TB_MEDICOS m
    JOIN cid c ON c.UF_CRM = m.UF_CRM
    JOIN base b ON b.UF_CRM = m.UF_CRM
    WHERE UPPER(m.SITUACAO) = 'ATIVO'
      AND b.DT_NOVO >= DATE_FROM_PARTS(${ano}, ${mo}, 1)
      AND b.DT_NOVO < DATEADD(MONTH, 1, DATE_FROM_PARTS(${ano}, ${mo}, 1))
    GROUP BY 1, 2, 3
    ORDER BY N DESC
  `);
  const cidades = (rows || []).filter((r) => r && r[1]).map((r) => ({
    uf: String(r[0] || ""),
    municipio: String(r[1] || ""),
    ibge: String(r[2] || ""),
    value: toNumber(r[3]),
  }));
  return { mes: stamp, cidades, total: cidades.length };
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
  queryDadosferaBi,
  queryMedicosNovos,
  queryCidadesNovos,
  statusPayload,
};
