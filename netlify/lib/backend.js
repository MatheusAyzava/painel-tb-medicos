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

  let gapRow = [];
  try {
    const gaps = await snowflakeSql(`
      WITH ativos AS (
        SELECT
          UF_CRM,
          TO_VARCHAR(CPF) AS CPF,
          REGEXP_REPLACE(TO_VARCHAR(CPF), '[^0-9]', '') AS CPF_DIG,
          TRIM(TO_VARCHAR(GENERO)) AS GENERO,
          DATA_NASCIMENTO,
          ANO_NASCIMENTO
        FROM GOLD.TB_MEDICOS
        WHERE UPPER(SITUACAO) = 'ATIVO'
      ),
      tels AS (
        SELECT DISTINCT TO_VARCHAR(CPF) AS CPF
        FROM GOLD.TB_MEDICOS_TELEFONES_FREQUENCIA
        WHERE NULLIF(REGEXP_REPLACE(TO_VARCHAR(TELEFONE), '[^0-9]', ''), '') IS NOT NULL
      ),
      mails AS (
        SELECT DISTINCT TO_VARCHAR(CPF) AS CPF
        FROM GOLD.TB_MEDICOS_EMAILS_FREQUENCIA
        WHERE NULLIF(TRIM(TO_VARCHAR(EMAIL)), '') IS NOT NULL
          AND TO_VARCHAR(EMAIL) ILIKE '%@%'
      )
      SELECT
        COUNT(DISTINCT CASE
          WHEN CPF_DIG IS NULL OR LENGTH(CPF_DIG) < 11 OR REGEXP_LIKE(CPF_DIG, '^(.)\\1{10}$')
          THEN UF_CRM END),
        COUNT(DISTINCT CASE WHEN t.CPF IS NULL THEN a.UF_CRM END),
        COUNT(DISTINCT CASE WHEN e.CPF IS NULL THEN a.UF_CRM END),
        COUNT(DISTINCT CASE
          WHEN NULLIF(a.GENERO, '') IS NULL
            OR UPPER(a.GENERO) IN ('NAO INFORMADO', 'NÃO INFORMADO')
          THEN a.UF_CRM END),
        COUNT(DISTINCT CASE
          WHEN a.DATA_NASCIMENTO IS NULL
           AND NULLIF(TRIM(TO_VARCHAR(a.ANO_NASCIMENTO)), '') IS NULL
          THEN a.UF_CRM END)
      FROM ativos a
      LEFT JOIN tels t ON t.CPF = a.CPF
      LEFT JOIN mails e ON e.CPF = a.CPF
    `);
    gapRow = (gaps && gaps[0]) || [];
  } catch {
    gapRow = [];
  }
  const lacunas = {
    sem_cpf: toNumber(gapRow[0]),
    sem_telefone: toNumber(gapRow[1]),
    sem_email: toNumber(gapRow[2]),
    sem_genero: toNumber(gapRow[3]),
    sem_nasc: toNumber(gapRow[4]),
  };

  return {
    valor: crm,
    crm_unicos: crm,
    cpf_unicos: toNumber(kpis[1]),
    total_medicos: toNumber(kpis[2]),
    total_registros: toNumber(kpis[3]),
    especialidades,
    fonte: "dadosfera",
    tabela: "DADOSFERA_PRD_DIGITALSOLVERS.GOLD.TB_MEDICOS",
    lacunas,
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

const CNES_NOME_COMUM = new Set([
  "ANA", "ANDRE", "ANTONIO", "BRUNO", "CARLOS", "DANIEL", "DIEGO", "EDUARDO",
  "FELIPE", "FERNANDO", "FRANCISCO", "GABRIEL", "GUSTAVO", "JOAO", "JOSE",
  "LEONARDO", "LUCAS", "LUIZ", "MARCOS", "MARIA", "MATEUS", "MATHEUS",
  "PAULA", "PAULO", "PEDRO", "RAFAEL", "RICARDO", "RODRIGO", "THIAGO", "TIAGO",
]);

function cnesBuscaParse(q) {
  const like = String(q || "").replace(/[%_\\']/g, "").slice(0, 80).toUpperCase();
  const compact = like.replace(/\s/g, "");
  const digits = String(q || "").replace(/\D/g, "").slice(0, 15);
  const tokens = like.split(/[\s,;./-]+/).filter((t) => t.length >= 2 && !/^\d+$/.test(t)).slice(0, 6);
  const isCrm = /^[A-Z]{2}\d{3,}/.test(compact) || /^\d{4,8}[A-Z]?$/.test(compact);
  return { compact, digits, tokens, isCrm };
}

function cnesAllowBlankCrm(tokens) {
  return (tokens || []).some((t) => t.length >= 5 && !CNES_NOME_COMUM.has(t));
}

function cnesNameSql(alias, tokens, col = "NOME") {
  if (!tokens.length) return "1=1";
  return tokens.map((t) => `UPPER(${alias}.${col}) LIKE '%${t}%'`).join(" AND ");
}

function cnesCidade(value) {
  return String(value || "").replace(/^\d+\s*[-–]\s*/, "").trim();
}

function cnesFmtComp(value) {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  const d = raw.replace(/\D/g, "");
  if (d.length >= 6) return `${d.slice(0, 4)}-${d.slice(4, 6)}`;
  return raw;
}

function cnesNovosSql(alias, ano, mo) {
  return `
    AND EXISTS (
      SELECT 1
      FROM GOLD.TB_ESPECIALIDADE_X_FONTES nv
      WHERE nv.UF_CRM = ${alias}.UF_CRM
        AND COALESCE(TRY_TO_DATE(nv.DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(nv.DT_INSCRICAO))
              >= DATE_FROM_PARTS(${ano}, ${mo}, 1)
        AND COALESCE(TRY_TO_DATE(nv.DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(nv.DT_INSCRICAO))
              < DATEADD(MONTH, 1, DATE_FROM_PARTS(${ano}, ${mo}, 1))
    )`;
}

function cnesMedicosSql(parsed, { uf, novos, ano, mo }) {
  const { compact, digits, tokens, isCrm } = parsed;
  const parts = [];
  if (isCrm) {
    const key = compact.slice(0, 20);
    const num = (digits || compact).replace(/\D/g, "").slice(0, 20);
    parts.push(`(m.UF_CRM = '${key}' OR m.UF_CRM ILIKE '%${num}')`);
  } else if (tokens.length) {
    parts.push(`(${cnesNameSql("m", tokens, "NOME")})`);
  }
  const where = parts.length ? parts.join(" OR ") : "1=0";
  return `
    SELECT m.UF_CRM, m.NOME,
      IFF(LENGTH(REGEXP_REPLACE(TO_VARCHAR(m.CPF), '[^0-9]', '')) >= 11,
          LOWER(SHA2(REGEXP_REPLACE(TO_VARCHAR(m.CPF), '[^0-9]', ''), 256)), NULL)
    FROM GOLD.TB_MEDICOS m
    WHERE (${where})
      ${uf ? `AND m.UF_CRM ILIKE '${uf}%'` : ""}
      ${novos ? cnesNovosSql("m", ano, mo) : ""}
    QUALIFY DENSE_RANK() OVER (ORDER BY m.NOME, m.UF_CRM) <= 40
  `;
}

function cnesFtpMesSql() {
  return `
    SELECT MAX(REGEXP_SUBSTR(FILE_PATH, 'PF[A-Z]{2}([0-9]{4})', 1, 1, 'e', 1))
    FROM (SELECT DISTINCT FILE_PATH FROM GOLD.TB_CNES_PROFISSIONAIS_FTP)
  `;
}

function cnesBuscaSql(parsed, { uf, novos, ano, mo, allowBlankCrm, ufCrms = [], hashes = [], ftpMes = "" }) {
  const { compact, digits, tokens, isCrm } = parsed;
  const parts = [];
  if (isCrm) {
    const key = compact.slice(0, 20);
    const num = (digits || compact).replace(/\D/g, "").slice(0, 20);
    parts.push(/^[A-Z]{2}/.test(key)
      ? `c.UF_CRM = '${key}'`
      : `(c.UF_CRM ILIKE '%${num}' OR TO_VARCHAR(c.CRM) = '${num}')`);
  } else if (tokens.length) {
    parts.push(`(${cnesNameSql("c", tokens, "NOME")})`);
  }
  if (digits.length >= 8 && digits.length !== 11) {
    parts.push(`TO_VARCHAR(c.CNS) LIKE '%${digits}%'`);
  }
  const safeCrms = (ufCrms || []).map((v) => String(v).replace(/[^A-Za-z0-9]/g, "")).filter(Boolean).slice(0, 40);
  const crmNums = [...new Set(safeCrms.map((v) => v.replace(/\D/g, "")).filter(Boolean))];
  const crmVars = [...new Set(safeCrms.concat(crmNums.flatMap((num) => [`AM${num}`, `SP${num}`])))].slice(0, 80);
  if (crmVars.length) parts.push(`c.UF_CRM IN (${crmVars.map((v) => `'${v}'`).join(",")})`);
  const where = parts.length ? parts.join(" OR ") : "1=0";
  const anomes = "('20' || REGEXP_SUBSTR(c.FILE_PATH, 'PF[A-Z]{2}([0-9]{4})', 1, 1, 'e', 1))";
  return `
    SELECT
      c.UF_CRM, c.NOME,
      IFF(LENGTH(REGEXP_REPLACE(TO_VARCHAR(c.CPF), '[^0-9]', '')) >= 11,
          LOWER(SHA2(REGEXP_REPLACE(TO_VARCHAR(c.CPF), '[^0-9]', ''), 256)),
          NULL),
      c.CNS, c.CRM, c.CBO, c.CNES,
      c.ESTABELECIMENTO,
      c.CNPJ,
      c.NATUREZA_JURIDICA,
      c.GESTAO, c.SUS, c.VINCULO_ESTABELECIMENTO, c.VINCULO_EMPREGADOR,
      c.CH_OUTROS, c.CH_AMB_, c.CH_HOSP_, c.CH_TOTAL,
      c.MUNICIPIO, c.UF, c.IBGE, c.TURNO,
      c.ESTABELECIMENTO, NULL, NULL, NULL, NULL,
      c.MUNICIPIO, c.UF, NULL, NULL, NULL,
      NULL, NULL, NULL, ${anomes}
    FROM GOLD.TB_CNES_PROFISSIONAIS_FTP c
    WHERE (${where})
      AND (NULLIF(c.UF_CRM, '') IS NOT NULL${allowBlankCrm ? " OR 1=1" : ""})
      ${/^\d{4}$/.test(String(ftpMes || "")) ? `AND c.FILE_PATH ILIKE '%${ftpMes}.csv'` : ""}
      ${uf ? `AND (c.UF = '${uf}' OR c.UF_CRM ILIKE '${uf}%')` : ""}
      ${novos ? cnesNovosSql("c", ano, mo) : ""}
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY COALESCE(NULLIF(c.UF_CRM, ''), TO_VARCHAR(c.CNS), c.NOME),
        COALESCE(TO_VARCHAR(c.CNES), c.ESTABELECIMENTO), COALESCE(c.CBO, ''),
        ${anomes}
      ORDER BY c.UPDATE_DATE DESC NULLS LAST
    ) = 1
    AND DENSE_RANK() OVER (ORDER BY c.NOME, c.UF_CRM) <= 40
    ORDER BY c.NOME, TRY_TO_DOUBLE(TO_VARCHAR(c.CH_TOTAL)) DESC NULLS LAST
  `;
}

function cnesDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function cnesUfDeCrm(ufCrm) {
  return String(ufCrm || "").replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase();
}

function cnesHashCpf(value) {
  const digits = cnesDigits(value);
  if (digits.length < 11) return "";
  return crypto.createHash("sha256").update(digits, "utf8").digest("hex");
}

function cnesPessoaKey(row) {
  const hashed = String((row && (row.cpf_hash || row.cpf)) || "").trim();
  if (/^[a-f0-9]{64}$/i.test(hashed)) return `id:${hashed.toLowerCase()}`;
  const fromPlain = cnesHashCpf(hashed);
  if (fromPlain) return `id:${fromPlain}`;
  const cns = cnesDigits(row && row.cns);
  if (cns.length >= 14) return `cns:${cns}`;
  const nome = String((row && row.nome) || "").trim().toUpperCase();
  const crm = cnesDigits(row && row.crm) || String((row && row.uf_crm) || "").replace(/^[A-Za-z]{2}/, "");
  return `crm:${nome}::${crm}`;
}

function cnesPublicId(row, groupedId, medico) {
  if (medico && medico.uf_crm) return `crm:${medico.uf_crm}`;
  const cns = cnesDigits(row && row.cns);
  if (cns.length >= 14) return `cns:${cns}`;
  const crm = String((row && row.uf_crm) || "").trim();
  if (crm) return `crm:${crm}`;
  return groupedId;
}

function cnesPublicVinculo(v, publicId, ufCrm, nome) {
  return {
    pessoa_id: publicId,
    uf_crm: ufCrm,
    nome: nome || v.nome || "",
    cns: v.cns || "",
    crm: v.crm || "",
    cbo: v.cbo || "",
    cnes: v.cnes || "",
    estabelecimento: v.estabelecimento || "",
    municipio: v.municipio || "",
    uf: v.uf || "",
    horas_total: Number(v.horas_total) || 0,
    competencia: cnesFmtComp(v.competencia),
  };
}

function cnesHorasPorCbo(rows) {
  const byCbo = new Map();
  rows.forEach((v) => {
    const label = String(v.cbo || "Sem CBO").trim() || "Sem CBO";
    if (!byCbo.has(label)) {
      byCbo.set(label, { cbo: label, horas: 0, vinculos: 0, estabelecimento: v.estabelecimento || "", _max: -1 });
    }
    const item = byCbo.get(label);
    const horas = Number(v.horas_total) || 0;
    item.horas += horas;
    item.vinculos += 1;
    if (horas >= item._max) {
      item._max = horas;
      item.estabelecimento = v.estabelecimento || item.estabelecimento;
    }
  });
  return [...byCbo.values()]
    .map(({ _max, ...rest }) => rest)
    .sort((a, b) => b.horas - a.horas || a.cbo.localeCompare(b.cbo, "pt-BR"));
}

function agruparCnes(vinculos, medicos = []) {
  const byHash = new Map();
  const byCrm = new Map();
  (medicos || []).forEach((m) => {
    if (m.cpf_hash && /^[a-f0-9]{64}$/.test(m.cpf_hash)) byHash.set(m.cpf_hash, m);
    if (m.uf_crm) byCrm.set(String(m.uf_crm).toUpperCase(), m);
  });
  const groups = new Map();
  (vinculos || []).forEach((v) => {
    const id = cnesPessoaKey(v);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(v);
  });
  const profissionais = [];
  const filtrados = [];
  groups.forEach((rows, id) => {
    const medico = byHash.get(String((rows[0] && rows[0].cpf_hash) || "").toLowerCase())
      || rows.map((v) => byCrm.get(String(v.uf_crm || "").toUpperCase())).find(Boolean);
    const byUf = new Map();
    rows.forEach((v) => {
      const uf = cnesUfDeCrm(v.uf_crm) || "_";
      const cur = byUf.get(uf) || { horas: 0, n: 0, uf_crm: v.uf_crm };
      cur.horas += Number(v.horas_total) || 0;
      cur.n += 1;
      byUf.set(uf, cur);
    });
    let canon = medico ? { uf_crm: medico.uf_crm, horas: 0, n: 0 } : null;
    byUf.forEach((info) => {
      if (!canon || (!medico && (info.horas > canon.horas || (info.horas === canon.horas && info.n > canon.n)))) {
        if (!medico) canon = info;
      }
    });
    if (!canon) canon = { uf_crm: (rows[0] && rows[0].uf_crm) || "", horas: 0, n: 0 };
    const kept = rows;
    const nome = (medico && medico.nome) || kept[0].nome;
    const publicId = cnesPublicId(kept[0], id, medico);
    const horasCbo = cnesHorasPorCbo(kept);
    const competencias = new Set();
    const doc = {
      pessoa_id: publicId,
      uf_crm: canon.uf_crm,
      nome,
      cns: kept[0].cns,
      crm: kept[0].crm || String(canon.uf_crm || "").replace(/^[A-Za-z]{2}/, ""),
      uf: kept[0].uf,
      horas_total: 0,
      vinculos: 0,
      estabelecimento: kept[0].estabelecimento,
      setor: kept[0].setor,
      cidades: new Set(),
      horas_cbo: horasCbo,
      _max: -1,
      principal_cnes: "",
    };
    kept.forEach((v) => {
      const pub = cnesPublicVinculo(v, publicId, canon.uf_crm, nome);
      filtrados.push(pub);
      doc.horas_total += pub.horas_total;
      doc.vinculos += 1;
      if (pub.competencia) competencias.add(pub.competencia);
      if (pub.municipio) doc.cidades.add(`${pub.municipio}/${pub.uf}`);
      if (pub.horas_total >= doc._max) {
        doc._max = pub.horas_total;
        doc.estabelecimento = pub.estabelecimento;
        doc.setor = v.setor;
        doc.principal_cnes = pub.cnes;
        doc.uf = pub.uf;
      }
    });
    profissionais.push({
      pessoa_id: doc.pessoa_id,
      uf_crm: doc.uf_crm,
      nome: doc.nome,
      cns: doc.cns,
      crm: doc.crm,
      uf: doc.uf,
      horas_total: doc.horas_total,
      vinculos: doc.vinculos,
      estabelecimento: doc.estabelecimento,
      setor: doc.setor,
      cidades: [...doc.cidades],
      competencias: [...competencias],
      horas_cbo: doc.horas_cbo,
      principal_cnes: doc.principal_cnes || "",
    });
  });
  return { profissionais, vinculos: filtrados };
}

function mergeMedicosSemCnes(grouped, medicos) {
  const seen = new Set((grouped.profissionais || []).map((p) => String(p.uf_crm || "").toUpperCase()).filter(Boolean));
  (medicos || []).forEach((m) => {
    const key = String(m.uf_crm || "").toUpperCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    grouped.profissionais.push({
      pessoa_id: `crm:${m.uf_crm}`,
      uf_crm: m.uf_crm,
      nome: m.nome,
      cns: "",
      crm: String(m.uf_crm).replace(/^[A-Za-z]{2}/, ""),
      uf: cnesUfDeCrm(m.uf_crm),
      horas_total: 0,
      vinculos: 0,
      estabelecimento: "",
      setor: "—",
      cidades: [],
      competencias: [],
      horas_cbo: [],
      principal_cnes: "",
    });
  });
  grouped.profissionais.sort((a, b) => String(a.nome || "").localeCompare(String(b.nome || ""), "pt-BR"));
  return grouped;
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
      uf_crm: ufCrm,
      nome,
      cpf_hash: String(r[2] || "").toLowerCase(),
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
    return { aviso: "Digite pelo menos 3 caracteres: nome, CRM ou CNS.", profissionais: [], vinculos: [] };
  }
  const parsed = cnesBuscaParse(q);
  if (!parsed.tokens.length && !parsed.isCrm && parsed.digits.length === 11) {
    return { aviso: "Por proteção de dados a busca não usa CPF. Pesquise por nome, CRM ou CNS.", profissionais: [], vinculos: [] };
  }
  const uf = String(opts.uf || "").replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 2);
  const novos = String(opts.novos || "").toLowerCase() === "true" || opts.novos === true;
  const ok = /^\d{4}-\d{2}$/.test(String(opts.mes || ""));
  const stamp = ok ? String(opts.mes) : new Date().toISOString().slice(0, 7);
  const [ano, mo] = stamp.split("-").map(Number);
  const allowBlankCrm = cnesAllowBlankCrm(parsed.tokens);
  const [medRows, mesRows] = await Promise.all([
    snowflakeSql(cnesMedicosSql(parsed, { uf, novos, ano, mo }), { timeout: 12, maxWait: 12000, poll: 400 }),
    snowflakeSql(cnesFtpMesSql(), { timeout: 12, maxWait: 12000, poll: 400 }),
  ]);
  const ftpMes = String((mesRows && mesRows[0] && mesRows[0][0]) || "").replace(/\D/g, "").slice(0, 4);
  const medicos = (medRows || []).map((r) => ({
    uf_crm: String(r[0] || ""),
    nome: String(r[1] || ""),
    cpf_hash: String(r[2] || "").toLowerCase(),
  })).filter((m) => m.uf_crm || m.nome);
  const rows = await snowflakeSql(cnesBuscaSql(parsed, {
    uf, novos, ano, mo, allowBlankCrm,
    ufCrms: medicos.map((m) => m.uf_crm),
    hashes: medicos.map((m) => m.cpf_hash),
    ftpMes,
  }), { timeout: 24, maxWait: 24000, poll: 400 });
  const grouped = mergeMedicosSemCnes(agruparCnes(mapCnesVinculos(rows), medicos), medicos);
  const aviso = grouped.profissionais.length
    ? ""
    : (novos
      ? "Nenhum médico novo deste mês corresponde à busca. Desmarque a opção para consultar a base completa."
      : "Nenhum profissional encontrado no CNES para essa busca.");
  return { q, mes: stamp, novos, total: grouped.profissionais.length, aviso, profissionais: grouped.profissionais, vinculos: grouped.vinculos };
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
