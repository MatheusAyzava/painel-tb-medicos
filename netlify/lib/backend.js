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

async function snowflakeSql(sql, opts = {}) {
  const { token, account } = snowflakeJwt();
  const base = `https://${account.toLowerCase()}.snowflakecomputing.com/api/v2/statements`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const timeoutSec = Number(opts.timeout || 60);
  const maxWait = Number(opts.maxWait || 50000);
  const pollMs = Number(opts.poll || 900);
  let res = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify({
      statement: sql,
      timeout: timeoutSec,
      database: process.env.SNOWFLAKE_DATABASE || "DADOSFERA_PRD_DIGITALSOLVERS",
      schema: "GOLD",
      warehouse: process.env.SNOWFLAKE_WAREHOUSE || "COMPUTE_WH",
    }),
  });
  let data = await res.json().catch(() => ({}));
  const started = Date.now();
  const pollHeaders = {
    Authorization: `Bearer ${token}`,
    "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
    Accept: "application/json",
  };
  while (
    (res.status === 202 || data.code === "333334") &&
    data.statementHandle &&
    Date.now() - started < maxWait
  ) {
    await new Promise((r) => setTimeout(r, pollMs));
    res = await fetch(`${base}/${data.statementHandle}`, { headers: pollHeaders });
    data = await res.json().catch(() => ({}));
  }
  if (res.status === 202 || data.code === "333334") {
    throw new Error("A consulta passou do tempo no Snowflake. Tente de novo em alguns segundos.");
  }
  if (!Array.isArray(data.data)) {
    throw new Error(data.message || data.error || `Snowflake HTTP ${res.status}`);
  }
  let rows = data.data;
  const partitions = (data.resultSetMetaData && data.resultSetMetaData.partitionInfo) || [];
  for (let i = 1; i < partitions.length; i++) {
    const part = await fetch(`${base}/${data.statementHandle}?partition=${i}`, { headers: pollHeaders });
    const pdata = await part.json().catch(() => ({}));
    if (Array.isArray(pdata.data)) rows = rows.concat(pdata.data);
  }
  return rows;
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

function citySqlFilter(opts = {}) {
  const uf = String(opts.uf || "").replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 2);
  const municipio = String(opts.municipio || "").replace(/[^A-Za-zÀ-ÿ0-9 .\-']/g, "").slice(0, 80);
  const ibgeDigits = String(opts.ibge || "").replace(/\D/g, "");
  let sql = "";
  if (uf) sql += ` AND p.UF = '${uf}'`;
  if (municipio) {
    sql += ` AND UPPER(p.MUNICIPIO) = UPPER('${municipio.replace(/'/g, "''")}')`;
  } else if (ibgeDigits) {
    const ibge7 = ibgeDigits.padStart(7, "0");
    const ibge6 = ibgeDigits.length >= 6 ? ibgeDigits.slice(0, 6) : ibgeDigits.padStart(6, "0");
    sql += ` AND (
      REGEXP_REPLACE(TO_VARCHAR(p.IBGE), '[^0-9]', '') IN ('${ibgeDigits}', '${ibge6}', '${ibge7}')
      OR LEFT(LPAD(REGEXP_REPLACE(TO_VARCHAR(p.IBGE), '[^0-9]', ''), 7, '0'), 6) = '${ibge6}'
    )`;
  }
  return { uf, municipio, ibge: ibgeDigits, sql };
}

function buscaSqlFilter(q, extra) {
  const like = String(q || "").replace(/[%_\\']/g, "").trim().slice(0, 80).toUpperCase();
  if (!like) return "";
  return `AND (
    UPPER(COALESCE(m.NOME, '')) LIKE '%${like}%'
    OR UPPER(COALESCE(m.UF_CRM, '')) LIKE '%${like}%'
    OR UPPER(COALESCE(tel.TELEFONE, '')) LIKE '%${like}%'
    OR UPPER(COALESCE(em.EMAIL, '')) LIKE '%${like}%'
    OR UPPER(COALESCE(cp.ESTABELECIMENTO, '')) LIKE '%${like}%'
    OR UPPER(COALESCE(cp.SETOR, '')) LIKE '%${like}%'
    ${extra || ""}
  )`;
}

function pageOpts(opts) {
  const pagina = Math.max(0, Number(opts.pagina) || 0);
  const tamanho = Math.min(3000, Math.max(1, Number(opts.tamanho) || 500));
  return { pagina, tamanho, offset: pagina * tamanho };
}

function cnesCtes(fromAlias) {
  return `
    cnes_horas AS (
      SELECT p.UF_CRM,
             SUM(TRY_TO_DOUBLE(TO_VARCHAR(p.CH_TOTAL))) HORAS_TOTAL,
             SUM(TRY_TO_DOUBLE(TO_VARCHAR(p.CH_AMB_))) HORAS_AMB,
             SUM(TRY_TO_DOUBLE(TO_VARCHAR(p.CH_HOSP_))) HORAS_HOSP,
             COUNT(DISTINCT NULLIF(TO_VARCHAR(p.CNES), '')) VINCULOS
      FROM GOLD.TB_CNES_PROFISSIONAIS p
      JOIN ${fromAlias} k ON k.UF_CRM = p.UF_CRM
      GROUP BY 1
    ),
    cnes_prin AS (
      SELECT p.UF_CRM, p.ESTABELECIMENTO, p.CNES, p.MUNICIPIO, p.UF, p.IBGE,
             p.NATUREZA_JURIDICA, p.GESTAO, p.SUS,
             CASE
               WHEN LEFT(REGEXP_REPLACE(COALESCE(TO_VARCHAR(p.NATUREZA_JURIDICA), ''), '[^0-9]', ''), 1) = '1' THEN 'Público'
               WHEN LEFT(REGEXP_REPLACE(COALESCE(TO_VARCHAR(p.NATUREZA_JURIDICA), ''), '[^0-9]', ''), 1) IN ('2', '3') THEN 'Privado'
               ELSE 'Não informado'
             END SETOR
      FROM GOLD.TB_CNES_PROFISSIONAIS p
      JOIN ${fromAlias} k ON k.UF_CRM = p.UF_CRM
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY p.UF_CRM
        ORDER BY TRY_TO_DOUBLE(TO_VARCHAR(p.CH_TOTAL)) DESC NULLS LAST, p.UPDATE_DATE DESC NULLS LAST
      ) = 1
    )`;
}

function mapMedicoRows(rows) {
  const lista = (rows || []).map((r) => ({
    uf_crm: String(r[0] || ""),
    nome: String(r[1] || ""),
    cidade: String(r[2] || ""),
    uf: String(r[3] || ""),
    telefone: String(r[4] || ""),
    email: String(r[5] || ""),
    data: String(r[6] || ""),
    especialidade: String(r[7] || ""),
    horas_total: toNumber(r[8]),
    horas_amb: toNumber(r[9]),
    horas_hosp: toNumber(r[10]),
    vinculos: toNumber(r[11]),
    estabelecimento: String(r[12] || ""),
    cnes: String(r[13] || ""),
    setor: String(r[14] || ""),
    natureza: String(r[15] || ""),
    gestao: String(r[16] || ""),
    sus: String(r[17] || ""),
  }));
  const totalCompleto = rows && rows.length ? toNumber(rows[0][18]) : 0;
  return { lista, totalCompleto: totalCompleto || lista.length };
}

function telOn(key) {
  return `
    LEFT JOIN (
      SELECT UF_CRM, TELEFONE FROM GOLD.TB_MEDICOS_TELEFONES_FREQUENCIA
      QUALIFY ROW_NUMBER() OVER (PARTITION BY UF_CRM ORDER BY QTDE_REPETICOES DESC NULLS LAST) = 1
    ) tel ON tel.UF_CRM = ${key}
    LEFT JOIN (
      SELECT UF_CRM, EMAIL FROM GOLD.TB_MEDICOS_EMAILS_FREQUENCIA
      QUALIFY ROW_NUMBER() OVER (PARTITION BY UF_CRM ORDER BY QTDE_REPETICOES DESC NULLS LAST) = 1
    ) em ON em.UF_CRM = ${key}`;
}

async function queryMedicosNovos(opts = {}) {
  const modo = String(opts.modo || "").toLowerCase() === "todos" ? "todos" : "novos";
  const ok = /^\d{4}-\d{2}$/.test(String(opts.mes || ""));
  const stamp = ok ? String(opts.mes) : new Date().toISOString().slice(0, 7);
  const [ano, mo] = stamp.split("-").map(Number);
  const exportarMes = Boolean(opts.exportar_mes) || String(opts.exportar_mes || "").toLowerCase() === "true";
  const city = exportarMes ? { uf: "", municipio: "", ibge: "", sql: "" } : citySqlFilter(opts);
  const { uf, municipio, ibge, sql: cityFilter } = city;
  if (modo === "todos" && !uf && !municipio && !ibge) {
    return { modo, mes: stamp, total: 0, total_completo: 0, linhas: [], aviso: "Clique numa cidade no mapa para listar os médicos." };
  }

  const semCidade = !exportarMes && Boolean(opts.sem_cidade) && modo === "novos";
  const { pagina, tamanho, offset } = pageOpts(opts);
  const dateFilter = modo === "novos"
    ? `AND b.DT_NOVO >= DATE_FROM_PARTS(${ano}, ${mo}, 1) AND b.DT_NOVO < DATEADD(MONTH, 1, DATE_FROM_PARTS(${ano}, ${mo}, 1))`
    : "";
  const joinBase = modo === "novos" ? "JOIN" : "LEFT JOIN";
  const like = String(opts.q || opts.busca || "").replace(/[%_\\']/g, "").trim().slice(0, 80).toUpperCase();
  const buscaCity = buscaSqlFilter(opts.q || opts.busca, like ? `OR UPPER(COALESCE(b.ESPECIALIDADE, '')) LIKE '%${like}%' OR UPPER(COALESCE(c.MUNICIPIO, cp.MUNICIPIO, '')) LIKE '%${like}%'` : "");
  const buscaNovos = buscaSqlFilter(opts.q || opts.busca, like ? `OR UPPER(n.UF_CRM) LIKE '%${like}%' OR UPPER(COALESCE(n.ESPECIALIDADE, '')) LIKE '%${like}%'` : "");

  let sql;
  if (semCidade) {
    sql = `
      WITH novos AS (
        SELECT UF_CRM,
               MIN(COALESCE(TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(DT_INSCRICAO))) AS DT_NOVO,
               MIN(COALESCE(NULLIF(ESPECIALIDADE, ''), NULLIF(ESPECIALIDADE_RQE, ''), 'SEM ESPECIALIDADE')) AS ESPECIALIDADE
        FROM GOLD.TB_ESPECIALIDADE_X_FONTES
        WHERE COALESCE(TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(DT_INSCRICAO))
                >= DATE_FROM_PARTS(${ano}, ${mo}, 1)
          AND COALESCE(TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(DT_INSCRICAO))
                < DATEADD(MONTH, 1, DATE_FROM_PARTS(${ano}, ${mo}, 1))
        GROUP BY UF_CRM
      ),
      cid AS (
        SELECT p.UF_CRM, p.MUNICIPIO, p.UF
        FROM novos n
        JOIN GOLD.TB_CNES_PROFISSIONAIS p ON p.UF_CRM = n.UF_CRM
        WHERE NULLIF(p.MUNICIPIO, '') IS NOT NULL
        QUALIFY ROW_NUMBER() OVER (PARTITION BY p.UF_CRM ORDER BY p.UPDATE_DATE DESC NULLS LAST) = 1
      ),
      ${cnesCtes("novos")}
      SELECT COALESCE(m.UF_CRM, n.UF_CRM), COALESCE(m.NOME, ''), 'Sem cidade · ' || COALESCE(m.UF, LEFT(n.UF_CRM, 2)),
             COALESCE(m.UF, LEFT(n.UF_CRM, 2)), tel.TELEFONE, em.EMAIL, TO_CHAR(n.DT_NOVO, 'YYYY-MM-DD'), n.ESPECIALIDADE,
             COALESCE(ch.HORAS_TOTAL, 0), COALESCE(ch.HORAS_AMB, 0), COALESCE(ch.HORAS_HOSP, 0), COALESCE(ch.VINCULOS, 0),
             cp.ESTABELECIMENTO, cp.CNES, cp.SETOR, cp.NATUREZA_JURIDICA, cp.GESTAO, cp.SUS, COUNT(*) OVER()
      FROM novos n
      LEFT JOIN cid c ON c.UF_CRM = n.UF_CRM
      LEFT JOIN GOLD.TB_MEDICOS m ON m.UF_CRM = n.UF_CRM
      ${telOn("n.UF_CRM")}
      LEFT JOIN cnes_horas ch ON ch.UF_CRM = n.UF_CRM
      LEFT JOIN cnes_prin cp ON cp.UF_CRM = n.UF_CRM
      WHERE c.UF_CRM IS NULL
        AND COALESCE(m.UF, LEFT(n.UF_CRM, 2)) = '${uf || ""}'
        ${buscaNovos}
      ORDER BY COALESCE(m.NOME, n.UF_CRM)
      LIMIT ${tamanho} OFFSET ${offset}
    `;
  } else if (cityFilter) {
    sql = `
      WITH cid AS (
        SELECT UF_CRM, MUNICIPIO, UF, IBGE
        FROM GOLD.TB_CNES_PROFISSIONAIS p
        WHERE NULLIF(UF_CRM, '') IS NOT NULL AND MUNICIPIO IS NOT NULL
          ${cityFilter}
        QUALIFY ROW_NUMBER() OVER (PARTITION BY UF_CRM ORDER BY UPDATE_DATE DESC NULLS LAST) = 1
      ),
      base AS (
        SELECT UF_CRM,
               MIN(COALESCE(TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(DT_INSCRICAO))) AS DT_NOVO,
               MIN(COALESCE(NULLIF(ESPECIALIDADE, ''), NULLIF(ESPECIALIDADE_RQE, ''), 'SEM ESPECIALIDADE')) AS ESPECIALIDADE
        FROM GOLD.TB_ESPECIALIDADE_X_FONTES GROUP BY UF_CRM
      ),
      ${cnesCtes("cid")}
      SELECT m.UF_CRM, m.NOME, COALESCE(c.MUNICIPIO, cp.MUNICIPIO), COALESCE(c.UF, cp.UF, m.UF),
             tel.TELEFONE, em.EMAIL, TO_CHAR(b.DT_NOVO, 'YYYY-MM-DD'), b.ESPECIALIDADE,
             COALESCE(ch.HORAS_TOTAL, 0), COALESCE(ch.HORAS_AMB, 0), COALESCE(ch.HORAS_HOSP, 0), COALESCE(ch.VINCULOS, 0),
             cp.ESTABELECIMENTO, cp.CNES, cp.SETOR, cp.NATUREZA_JURIDICA, cp.GESTAO, cp.SUS, COUNT(*) OVER()
      FROM GOLD.TB_MEDICOS m
      JOIN cid c ON c.UF_CRM = m.UF_CRM
      ${joinBase} base b ON b.UF_CRM = m.UF_CRM
      ${telOn("m.UF_CRM")}
      LEFT JOIN cnes_horas ch ON ch.UF_CRM = m.UF_CRM
      LEFT JOIN cnes_prin cp ON cp.UF_CRM = m.UF_CRM
      WHERE UPPER(m.SITUACAO) = 'ATIVO' ${dateFilter} ${buscaCity}
      ORDER BY m.NOME
      LIMIT ${tamanho} OFFSET ${offset}
    `;
  } else {
    sql = `
      WITH n AS (
        SELECT UF_CRM,
               MIN(COALESCE(TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(DT_INSCRICAO))) AS DT_NOVO,
               MIN(COALESCE(NULLIF(ESPECIALIDADE, ''), NULLIF(ESPECIALIDADE_RQE, ''), 'SEM ESPECIALIDADE')) AS ESPECIALIDADE
        FROM GOLD.TB_ESPECIALIDADE_X_FONTES
        GROUP BY UF_CRM
      ),
      ${cnesCtes("n")}
      SELECT COALESCE(m.UF_CRM, n.UF_CRM), COALESCE(m.NOME, ''), COALESCE(cp.MUNICIPIO, ''),
             COALESCE(cp.UF, m.UF, LEFT(n.UF_CRM, 2)), tel.TELEFONE, em.EMAIL, TO_CHAR(n.DT_NOVO, 'YYYY-MM-DD'), n.ESPECIALIDADE,
             COALESCE(ch.HORAS_TOTAL, 0), COALESCE(ch.HORAS_AMB, 0), COALESCE(ch.HORAS_HOSP, 0), COALESCE(ch.VINCULOS, 0),
             cp.ESTABELECIMENTO, cp.CNES, cp.SETOR, cp.NATUREZA_JURIDICA, cp.GESTAO, cp.SUS, COUNT(*) OVER()
      FROM n
      LEFT JOIN GOLD.TB_MEDICOS m ON m.UF_CRM = n.UF_CRM
      ${telOn("n.UF_CRM")}
      LEFT JOIN cnes_horas ch ON ch.UF_CRM = n.UF_CRM
      LEFT JOIN cnes_prin cp ON cp.UF_CRM = n.UF_CRM
      WHERE 1=1
        ${modo === "novos" ? `AND n.DT_NOVO >= DATE_FROM_PARTS(${ano}, ${mo}, 1) AND n.DT_NOVO < DATEADD(MONTH, 1, DATE_FROM_PARTS(${ano}, ${mo}, 1))` : ""}
        ${buscaNovos}
      ORDER BY COALESCE(m.NOME, n.UF_CRM)
      LIMIT ${tamanho} OFFSET ${offset}
    `;
  }

  const rows = await snowflakeSql(sql);
  const mapped = mapMedicoRows(rows);
  return {
    modo,
    mes: stamp,
    uf,
    municipio,
    ibge,
    pagina,
    tamanho,
    total: mapped.lista.length,
    total_completo: mapped.totalCompleto,
    linhas: mapped.lista,
  };
}

async function queryCidadesNovos(opts = {}) {
  const ok = /^\d{4}-\d{2}$/.test(String(opts.mes || ""));
  const stamp = ok ? String(opts.mes) : new Date().toISOString().slice(0, 7);
  const [ano, mo] = stamp.split("-").map(Number);
  const rows = await snowflakeSql(`
    WITH novos AS (
      SELECT UF_CRM
      FROM GOLD.TB_ESPECIALIDADE_X_FONTES
      WHERE COALESCE(TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(DT_INSCRICAO))
              >= DATE_FROM_PARTS(${ano}, ${mo}, 1)
        AND COALESCE(TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(DT_INSCRICAO))
              < DATEADD(MONTH, 1, DATE_FROM_PARTS(${ano}, ${mo}, 1))
        AND YEAR(COALESCE(TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(DT_INSCRICAO)))
              BETWEEN 2000 AND YEAR(CURRENT_DATE())
      GROUP BY UF_CRM
    ),
    cid AS (
      SELECT p.UF_CRM, p.MUNICIPIO, p.UF, p.IBGE
      FROM novos n
      JOIN GOLD.TB_CNES_PROFISSIONAIS p ON p.UF_CRM = n.UF_CRM
      WHERE NULLIF(p.MUNICIPIO, '') IS NOT NULL
      QUALIFY ROW_NUMBER() OVER (PARTITION BY p.UF_CRM ORDER BY p.UPDATE_DATE DESC NULLS LAST) = 1
    )
    SELECT
      COALESCE(NULLIF(c.UF, ''), m.UF, LEFT(n.UF_CRM, 2)) UF,
      COALESCE(NULLIF(c.MUNICIPIO, ''), 'Sem cidade · ' || COALESCE(NULLIF(c.UF, ''), m.UF, LEFT(n.UF_CRM, 2))) MUNICIPIO,
      COALESCE(TO_VARCHAR(c.IBGE), '') IBGE,
      COUNT(DISTINCT n.UF_CRM) N,
      IFF(NULLIF(c.MUNICIPIO, '') IS NULL, 1, 0) SEM_CIDADE
    FROM novos n
    LEFT JOIN cid c ON c.UF_CRM = n.UF_CRM
    LEFT JOIN GOLD.TB_MEDICOS m ON m.UF_CRM = n.UF_CRM
    GROUP BY 1, 2, 3, 5
    ORDER BY N DESC
  `);
  const cidades = (rows || []).filter((r) => r && r[0] && r[1]).map((r) => ({
    uf: String(r[0] || "").toUpperCase(),
    municipio: String(r[1] || ""),
    ibge: String(r[2] || ""),
    value: toNumber(r[3]),
    sem_cidade: toNumber(r[4]) === 1,
  }));
  const medicos = cidades.reduce((s, c) => s + c.value, 0);
  return { mes: stamp, cidades, total: cidades.length, medicos };
}

function cnesSetor(natureza, grupo) {
  const g = String(grupo || "").toUpperCase();
  if (g.startsWith("1") || g.includes("ADMINISTRA")) return "Público";
  if (g.startsWith("2") || g.startsWith("3") || g.includes("EMPRESAR") || g.includes("PRIVAD")) return "Privado";
  const d = String(natureza || "").replace(/\D/g, "").slice(0, 1);
  if (d === "1") return "Público";
  if (d === "2" || d === "3") return "Privado";
  return "Não informado";
}

function cnesBuscaParse(q) {
  const like = String(q || "").replace(/[%_\\']/g, "").slice(0, 80).toUpperCase();
  const compact = like.replace(/\s/g, "");
  const digits = String(q || "").replace(/\D/g, "").slice(0, 15);
  const tokens = like.split(/[\s,;./-]+/).filter((t) => t.length >= 2 && !/^\d+$/.test(t)).slice(0, 6);
  const isCrm = /^[A-Z]{2}\d{3,}/.test(compact) || /^\d{4,8}[A-Z]?$/.test(compact);
  return { compact, digits, tokens, isCrm };
}

function cnesNameSql(alias, tokens, col = "NOME") {
  if (!tokens.length) return "1=1";
  return tokens.map((t) => `UPPER(${alias}.${col}) LIKE '%${t}%'`).join(" AND ");
}

function cnesCidade(value) {
  return String(value || "").replace(/^\d+\s*[-–]\s*/, "").trim();
}

function cnesBuscaSql(parsed, { uf, novos, ano, mo }) {
  const { compact, digits, tokens, isCrm } = parsed;
  const parts = [];
  if (isCrm) {
    const key = compact.slice(0, 20);
    const num = (digits || compact).slice(0, 20);
    parts.push(`(c.UF_CRM = '${key}' OR c.UF_CRM ILIKE '%${num}' OR TO_VARCHAR(c.CRM) = '${num}')`);
  } else if (tokens.length) {
    parts.push(`(${cnesNameSql("c", tokens, "NOME_PROFISSIONAL")})`);
  }
  if (digits.length >= 8) {
    parts.push(`(TO_VARCHAR(c.CPF) LIKE '%${digits}%' OR TO_VARCHAR(c.CNS) LIKE '%${digits}%')`);
  }
  const where = parts.length ? parts.join(" OR ") : "1=0";
  const novosSql = novos ? `
    AND EXISTS (
      SELECT 1
      FROM GOLD.TB_ESPECIALIDADE_X_FONTES nv
      WHERE nv.UF_CRM = c.UF_CRM
        AND COALESCE(TRY_TO_DATE(nv.DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(nv.DT_INSCRICAO))
              >= DATE_FROM_PARTS(${ano}, ${mo}, 1)
        AND COALESCE(TRY_TO_DATE(nv.DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(nv.DT_INSCRICAO))
              < DATEADD(MONTH, 1, DATE_FROM_PARTS(${ano}, ${mo}, 1))
    )` : "";
  return `
    SELECT
      c.UF_CRM, c.NOME_PROFISSIONAL, c.CPF, c.CNS, c.CRM, c.CBO, c.CNES,
      COALESCE(c.NOME_ESTABELECIMENTO, c.ESTABELECIMENTO),
      COALESCE(c.CNPJ_ESTABELECIMENTO, c.CNPJ_PROFISSIONAL),
      COALESCE(c.NATUREZA_JURIDICA_PROFISSIONAL, c.NATUREZA_JURIDICA_ESTABELECIMENTO),
      c.GESTAO_PROFISSIONAL, c.SUS, c.VINCULO_ESTABELECIMENTO, c.VINCULO_EMPREGADOR,
      c.CH_OUTROS, c.CH_AMB_, c.CH_HOSP_, c.CH_TOTAL,
      c.MUNICIPIO_ESTABELECIMENTO, c.UF_ESTABELECIMENTO, c.IBGE, c.TURNO_PROFISSIONAL,
      c.NOME_ESTABELECIMENTO, c.LOGRADOURO, c.NUMERO, c.COMPLEMENTO, c.BAIRRO,
      c.MUNICIPIO_ESTABELECIMENTO, c.UF_ESTABELECIMENTO, c.CEP, c.TELEFONE, c.EMAIL,
      c.GRUPO_NATUREZA_JURIDICA, c.TIPO_ESTABELECIMENTO, c.TIPO_UNIDADE, c.ANOMES
    FROM GOLD.TB_CNES_PROFISSIONAIS_ESTABELECIMENTOS c
    WHERE NULLIF(c.UF_CRM, '') IS NOT NULL
      AND (${where})
      ${uf ? `AND (c.UF_ESTABELECIMENTO = '${uf}' OR c.UF_CRM ILIKE '${uf}%')` : ""}
      ${novosSql}
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY c.UF_CRM, c.NOME_PROFISSIONAL, COALESCE(TO_VARCHAR(c.CNES), c.ESTABELECIMENTO)
      ORDER BY c.UPDATE_DATE DESC NULLS LAST, c.ANOMES DESC NULLS LAST
    ) = 1
    AND DENSE_RANK() OVER (ORDER BY c.NOME_PROFISSIONAL, c.UF_CRM) <= 25
    ORDER BY c.NOME_PROFISSIONAL, TRY_TO_DOUBLE(TO_VARCHAR(c.CH_TOTAL)) DESC NULLS LAST
  `;
}

function cnesPessoaKey(ufCrm, nome) {
  return `${String(ufCrm || "").trim()}::${String(nome || "").trim().toUpperCase()}`;
}

function mapCnesVinculos(rows) {
  return (rows || []).map((r) => {
    const horas = toNumber(r[17]);
    const natureza = String(r[9] || "");
    const grupo = String(r[32] || "");
    const logradouro = [r[23], r[24], r[25]].filter(Boolean).join(", ");
    const nome = String(r[1] || "");
    const ufCrm = String(r[0] || "");
    return {
      pessoa_id: cnesPessoaKey(ufCrm, nome),
      uf_crm: ufCrm,
      nome,
      cpf: String(r[2] || ""),
      cns: String(r[3] || ""),
      crm: String(r[4] || ""),
      cbo: String(r[5] || ""),
      cnes: String(r[6] || ""),
      estabelecimento: String(r[22] || r[7] || ""),
      cnpj: String(r[8] || ""),
      natureza,
      gestao: String(r[10] || ""),
      sus: String(r[11] || ""),
      vinculo: String(r[12] || ""),
      empregador: String(r[13] || ""),
      horas_outros: toNumber(r[14]),
      horas_amb: toNumber(r[15]),
      horas_hosp: toNumber(r[16]),
      horas_total: horas,
      municipio: cnesCidade(r[27] || r[18] || ""),
      uf: String(r[28] || r[19] || ""),
      ibge: String(r[20] || ""),
      turno: String(r[21] || ""),
      endereco: logradouro,
      bairro: String(r[26] || ""),
      cep: String(r[29] || ""),
      telefone: String(r[30] || ""),
      email: String(r[31] || ""),
      grupo,
      tipo: String(r[33] || ""),
      unidade: String(r[34] || ""),
      competencia: String(r[35] || ""),
      setor: cnesSetor(natureza, grupo),
    };
  });
}

async function queryCnesBusca(opts = {}) {
  const q = String(opts.q || "").trim();
  const compactQ = q.replace(/\s/g, "");
  if (compactQ.length < 3) {
    return { aviso: "Digite pelo menos 3 caracteres: nome, CRM, CPF ou CNS.", profissionais: [], vinculos: [] };
  }
  const parsed = cnesBuscaParse(q);
  const uf = String(opts.uf || "").replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 2);
  const novos = String(opts.novos || "").toLowerCase() === "true" || opts.novos === true;
  const ok = /^\d{4}-\d{2}$/.test(String(opts.mes || ""));
  const stamp = ok ? String(opts.mes) : new Date().toISOString().slice(0, 7);
  const [ano, mo] = stamp.split("-").map(Number);
  const rows = await snowflakeSql(cnesBuscaSql(parsed, { uf, novos, ano, mo }), { timeout: 18, maxWait: 18000, poll: 400 });
  const vinculos = mapCnesVinculos(rows);
  const byDoc = new Map();
  vinculos.forEach((v) => {
    const id = cnesPessoaKey(v.uf_crm, v.nome);
    v.pessoa_id = id;
    if (!byDoc.has(id)) {
      byDoc.set(id, {
        pessoa_id: id,
        uf_crm: v.uf_crm,
        nome: v.nome,
        cpf: v.cpf,
        cns: v.cns,
        crm: v.crm,
        uf: v.uf,
        horas_total: 0,
        vinculos: 0,
        estabelecimento: v.estabelecimento,
        setor: v.setor,
        cidades: new Set(),
      });
    }
    const doc = byDoc.get(id);
    doc.horas_total += v.horas_total;
    doc.vinculos += 1;
    if (v.municipio) doc.cidades.add(`${v.municipio}/${v.uf}`);
    if (v.horas_total >= (doc._max || 0)) {
      doc._max = v.horas_total;
      doc.estabelecimento = v.estabelecimento;
      doc.setor = v.setor;
      doc.principal_cnes = v.cnes;
    }
  });
  const profissionais = [...byDoc.values()].map((d) => ({
    pessoa_id: d.pessoa_id,
    uf_crm: d.uf_crm,
    nome: d.nome,
    cpf: d.cpf,
    cns: d.cns,
    crm: d.crm,
    uf: d.uf,
    horas_total: d.horas_total,
    vinculos: d.vinculos,
    estabelecimento: d.estabelecimento,
    setor: d.setor,
    cidades: [...d.cidades],
    principal_cnes: d.principal_cnes || "",
  }));
  const aviso = profissionais.length
    ? ""
    : (novos
      ? "Nenhum médico novo deste mês corresponde à busca. Desmarque a opção para consultar a base completa."
      : "Nenhum profissional encontrado no CNES para essa busca.");
  return { q, mes: stamp, novos, total: profissionais.length, aviso, profissionais, vinculos };
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
  queryCnesBusca,
  statusPayload,
};
