#!/usr/bin/env python3
"""Painel TB Médicos. Rode: python server.py"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import shutil
import ssl
import sys
import time
import zipfile
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).parent.resolve()
SECRETS = ROOT / "secrets"
CNES_LAST = SECRETS / "cnes_last.json"
UPLOADS = SECRETS / "uploads"
SNAPSHOT = ROOT / "assets" / "snapshot.json"
PORT = int(os.environ.get("PORT", "8765"))
HOST = os.environ.get("HOST", "127.0.0.1")
IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
BR_UFS = {
    "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT",
    "PA", "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO",
}
try:
    csv.field_size_limit(min(sys.maxsize, 50_000_000))
except OverflowError:
    csv.field_size_limit(10_000_000)


def load_cfg() -> dict:
    path = SECRETS / "config.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def merge_cfg(override: dict | None = None) -> dict:
    cfg = load_cfg()
    for key, value in (override or {}).items():
        if value not in (None, ""):
            cfg[key] = value
    return cfg


def read_json(handler: SimpleHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length") or 0)
    raw = handler.rfile.read(length) if length else b"{}"
    if not raw:
        return {}
    return json.loads(raw.decode("utf-8"))


def send_json(handler: SimpleHTTPRequestHandler, payload: dict, status: int = 200) -> None:
    body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def first_number(value):
    try:
        from decimal import Decimal
    except ImportError:
        Decimal = None
    if isinstance(value, bool):
        return None
    if Decimal is not None and isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if not text or text[0].isalpha():
            return None
        if text.count(".") > 1 and "," not in text:
            text = text.replace(".", "")
        elif "," in text and "." in text:
            text = text.replace(".", "").replace(",", ".")
        elif "," in text:
            text = text.replace(",", ".")
        try:
            return float(text)
        except ValueError:
            return None
    if isinstance(value, (list, tuple)):
        for item in value:
            found = first_number(item)
            if found is not None:
                return found
        return None
    if isinstance(value, dict):
        for item in value.values():
            found = first_number(item)
            if found is not None:
                return found
    return None


def as_int(rows) -> int:
    n = first_number(rows)
    return int(round(n)) if n is not None else 0


def private_key_bytes():
    from cryptography.hazmat.primitives import serialization

    cfg = load_cfg()
    key_path = SECRETS / cfg.get("snowflake_key_file", "snowflake_rsa_key.p8")
    pem = key_path.read_bytes()
    p_key = serialization.load_pem_private_key(pem, password=None)
    return p_key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )


def connect_snowflake(cfg: dict):
    try:
        import snowflake.connector
    except ImportError as exc:
        raise RuntimeError("Instale: pip install snowflake-connector-python cryptography") from exc

    account = (cfg.get("snowflake_account") or cfg.get("account") or "").strip()
    account = account.replace(".snowflakecomputing.com", "")
    user = (cfg.get("snowflake_user") or cfg.get("user") or "").strip()
    warehouse = (cfg.get("snowflake_warehouse") or cfg.get("warehouse") or "COMPUTE_WH").strip()
    if not account or not user:
        raise RuntimeError("Snowflake sem account/user.")
    if not IDENT.match(warehouse):
        raise RuntimeError("Warehouse inválido.")

    kwargs = {
        "user": user,
        "account": account,
        "warehouse": warehouse,
        "database": cfg.get("snowflake_database") or "DADOSFERA_PRD_DIGITALSOLVERS",
        "schema": cfg.get("snowflake_schema") or "GOLD",
        "private_key": private_key_bytes(),
    }
    if cfg.get("role") or cfg.get("snowflake_role"):
        kwargs["role"] = cfg.get("role") or cfg.get("snowflake_role")
    if cfg.get("database") or cfg.get("snowflake_database"):
        kwargs["database"] = cfg.get("database") or cfg.get("snowflake_database")
    return snowflake.connector.connect(**kwargs)


def snowflake_fetch(ctx, sql: str):
    cur = ctx.cursor()
    try:
        cur.execute(sql)
        rows = cur.fetchall()
        cols = [c[0] for c in (cur.description or [])]
        return cols, rows
    finally:
        cur.close()


def norm_col(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(name).lower())


def pick_col(columns: list, aliases: list[str]):
    cols = [str(c) for c in columns]
    lowered = [norm_col(c) for c in cols]
    for alias in aliases:
        needle = norm_col(alias)
        for original, name in zip(cols, lowered):
            if name == needle:
                return original
        if len(needle) < 4:
            continue
        for original, name in zip(cols, lowered):
            if needle in name:
                return original
    return None


def ident(name: str, dialect: str) -> str:
    clean = str(name).replace('"', "").replace("`", "")
    if dialect == "snowflake":
        return f'"{clean}"'
    return f"`{clean}`"


def ufcrm_expr(columns: list, dialect: str) -> str | None:
    uf_crm = pick_col(columns, ["uf_crm", "ufcrm", "ds_codigo"])
    if uf_crm:
        return ident(uf_crm, dialect)
    crm = pick_col(columns, ["crm", "nr_crm", "numero_crm", "nro_crm", "nu_crm", "co_crm"])
    uf = pick_col(columns, ["uf", "sg_uf", "sigla_uf"])
    if crm and uf:
        c_crm, c_uf = ident(crm, dialect), ident(uf, dialect)
        if dialect == "snowflake":
            return f"CONCAT(TO_VARCHAR(COALESCE({c_uf}, '')), '|', TO_VARCHAR(COALESCE({c_crm}, '')))"
        return f"CONCAT(CAST(COALESCE({c_uf}, '') AS STRING), '|', CAST(COALESCE({c_crm}, '') AS STRING))"
    if crm:
        return ident(crm, dialect)
    return None


def ativo_where(columns: list, dialect: str) -> str:
    sit = pick_col(columns, ["situacao", "status", "st_situacao"])
    if not sit:
        return ""
    col = ident(sit, dialect)
    cast = "VARCHAR" if dialect == "snowflake" else "STRING"
    return f" WHERE UPPER(CAST({col} AS {cast})) = 'ATIVO'"


def date_col(columns: list, *aliases: str):
    found = pick_col(columns, list(aliases))
    if found:
        return found
    for col in columns:
        n = norm_col(col)
        if any(norm_col(a) in n for a in aliases):
            return col
    return None


def query_snowflake(override: dict | None = None) -> dict:
    cfg = merge_cfg(override)
    ctx = connect_snowflake(cfg)
    warehouse = (cfg.get("snowflake_warehouse") or "COMPUTE_WH").strip()
    try:
        cur = ctx.cursor()
        cur.execute(f"USE WAREHOUSE {warehouse}")
        cur.execute("USE DATABASE DADOSFERA_PRD_DIGITALSOLVERS")
        cur.close()

        custom = (override or {}).get("sql") or cfg.get("snowflake_sql")
        if custom:
            cols, rows = snowflake_fetch(ctx, custom)
            if not rows:
                raise RuntimeError("A consulta do Snowflake não retornou linhas.")
            return {
                "valor": as_int(rows),
                "fonte": "dadosfera",
                "colunas": cols,
                "linhas": [list(r) for r in rows[:40]],
            }

        def scalar_int(sql: str) -> int:
            return as_int(snowflake_fetch(ctx, sql)[1])

        def scalar_date(sql: str):
            try:
                rows = snowflake_fetch(ctx, sql)[1]
                if rows and rows[0] and rows[0][0] is not None:
                    return rows[0][0]
            except Exception:
                return None
            return None

        crm_unicos = scalar_int(
            """
            SELECT COUNT(DISTINCT UF_CRM) AS CRM_UNICOS
            FROM GOLD.TB_MEDICOS
            WHERE UPPER(SITUACAO) = 'ATIVO'
            """
        )
        cpf_unicos = scalar_int(
            """
            SELECT COUNT(DISTINCT CPF) AS TOTAL_CPFS
            FROM GOLD.TB_MEDICOS
            WHERE UPPER(SITUACAO) = 'ATIVO'
            """
        )
        total_medicos = scalar_int(
            """
            SELECT COUNT(*) AS TOTAL_MEDICOS
            FROM GOLD.TB_MEDICOS
            WHERE UPPER(SITUACAO) = 'ATIVO'
            """
        )
        total_registros = scalar_int(
            """
            SELECT COUNT(DISTINCT UF_CRM) AS TOTAL_UF_CRMS
            FROM GOLD.TB_MEDICOS
            WHERE 1=1
            """
        )

        atualizado_gold = scalar_date("SELECT TO_CHAR(MAX(UPDATE_DATE), 'YYYY-MM-DD HH24:MI:SS') AS ULTIMA_ATUALIZACAO FROM GOLD.TB_MEDICOS")
        atualizado_cfm = scalar_date("SELECT TO_CHAR(MAX(UPDATE_DATE), 'YYYY-MM-DD HH24:MI:SS') AS ULTIMA_ATUALIZACAO_CFM FROM SILVER.TB_CFM")
        atualizado_cnes = atualizado_gold

        especialidades = 0
        try:
            especialidades = scalar_int(
                """
                SELECT COUNT(DISTINCT ESPECIALIDADE) AS QTD_ESPECIALIDADES
                FROM GOLD.TB_ESPECIALIDADE_X_FONTES
                WHERE 1=1
                """
            )
        except Exception:
            especialidades = 0

        ufs = []
        try:
            urows = snowflake_fetch(
                ctx,
                """
                SELECT UF, COUNT(DISTINCT UF_CRM) AS N
                FROM GOLD.TB_MEDICOS
                WHERE UPPER(SITUACAO) = 'ATIVO'
                GROUP BY UF
                ORDER BY N DESC
                LIMIT 12
                """,
            )[1]
            ufs = [{"uf": str(r[0]), "value": as_int([r[1]])} for r in urows if r and r[0] is not None]
        except Exception:
            ufs = []

        genero = []
        try:
            grows = snowflake_fetch(
                ctx,
                """
                SELECT COALESCE(GENERO, 'Não informado') AS GENERO, COUNT(*) AS QTD_MEDICOS
                FROM GOLD.TB_MEDICOS
                WHERE UPPER(SITUACAO) = 'ATIVO'
                GROUP BY GENERO
                ORDER BY QTD_MEDICOS DESC
                """,
            )[1]
            genero = [{"label": str(r[0] or "Não informado"), "value": as_int([r[1]])} for r in grows]
        except Exception:
            genero = []

        tipo = []
        try:
            trows = snowflake_fetch(
                ctx,
                """
                SELECT TIPO_INSCRICAO, COUNT(*) AS QTD_MEDICOS
                FROM GOLD.TB_MEDICOS
                WHERE UPPER(SITUACAO) = 'ATIVO'
                GROUP BY TIPO_INSCRICAO
                ORDER BY QTD_MEDICOS DESC
                """,
            )[1]
            tipo = [{"label": str(r[0] or "Other"), "value": as_int([r[1]])} for r in trows]
        except Exception:
            tipo = []

        extras = [
            {"label": "CRMs únicos ativos", "value": crm_unicos, "accent": True},
            {"label": "CPFs únicos ativos", "value": cpf_unicos},
            {"label": "Total médicos ativos", "value": total_medicos},
            {"label": "Total registros (todas situações)", "value": total_registros},
        ]
        if especialidades:
            extras.append({"label": "Especialidades", "value": especialidades})

        payload = {
            "valor": crm_unicos,
            "crm_unicos": crm_unicos,
            "cpf_unicos": cpf_unicos,
            "total_medicos": total_medicos,
            "total_registros": total_registros,
            "especialidades": especialidades,
            "fonte": "dadosfera",
            "tabela": "DADOSFERA_PRD_DIGITALSOLVERS.GOLD.TB_MEDICOS",
            "metrica": "COUNT(DISTINCT UF_CRM) ATIVO",
            "ufs": ufs,
            "genero": genero,
            "tipo_inscricao": tipo,
            "extras": extras,
            "atualizado_em": atualizado_gold,
            "atualizado_cnes": atualizado_cnes,
            "atualizado_cfm": atualizado_cfm,
        }
        merge_snapshot("dadosfera", payload)
        return payload
    finally:
        ctx.close()


UF_REGIAO = {
    "AC": "Norte", "AP": "Norte", "AM": "Norte", "PA": "Norte", "RO": "Norte", "RR": "Norte", "TO": "Norte",
    "AL": "Nordeste", "BA": "Nordeste", "CE": "Nordeste", "MA": "Nordeste", "PB": "Nordeste",
    "PE": "Nordeste", "PI": "Nordeste", "RN": "Nordeste", "SE": "Nordeste",
    "ES": "Sudeste", "MG": "Sudeste", "RJ": "Sudeste", "SP": "Sudeste",
    "PR": "Sul", "RS": "Sul", "SC": "Sul",
    "DF": "Centro-Oeste", "GO": "Centro-Oeste", "MS": "Centro-Oeste", "MT": "Centro-Oeste",
}


def label_rows(rows):
    return [{"label": str(r[0] or "Não informado"), "value": as_int([r[1]])} for r in rows if r]


def query_dadosfera_bi(override: dict | None = None) -> dict:
    cfg = merge_cfg(override)
    ctx = connect_snowflake(cfg)
    warehouse = (cfg.get("snowflake_warehouse") or "COMPUTE_WH").strip()
    try:
        cur = ctx.cursor()
        cur.execute(f"USE WAREHOUSE {warehouse}")
        cur.execute("USE DATABASE DADOSFERA_PRD_DIGITALSOLVERS")
        cur.close()

        def q(sql: str):
            return snowflake_fetch(ctx, sql)[1]

        kpis = q(
            """
            SELECT
              (SELECT COUNT(DISTINCT UF_CRM) FROM GOLD.TB_MEDICOS WHERE UPPER(SITUACAO) = 'ATIVO') AS CRM,
              (SELECT COUNT(DISTINCT CPF) FROM GOLD.TB_MEDICOS WHERE UPPER(SITUACAO) = 'ATIVO') AS MEDICOS,
              (SELECT COUNT(DISTINCT ESPECIALIDADE) FROM GOLD.TB_ESPECIALIDADE_X_FONTES) AS ESPECIALIDADES,
              (SELECT TO_CHAR(MAX(UPDATE_DATE), 'YYYY-MM-DD HH24:MI:SS') FROM GOLD.TB_MEDICOS) AS ATUALIZADO
            """
        )[0]
        genero = label_rows(q(
            """
            SELECT COALESCE(GENERO, 'Não informado'), COUNT(*)
            FROM GOLD.TB_MEDICOS
            WHERE UPPER(SITUACAO) = 'ATIVO'
            GROUP BY 1
            ORDER BY 2 DESC
            """
        ))
        faixa = label_rows(q(
            """
            SELECT COALESCE(FAIXA_ETARIA, 'Não definida'), COUNT(DISTINCT UF_CRM)
            FROM GOLD.TB_ESPECIALIDADE_X_FONTES
            WHERE UPPER(SITUACAO) = 'ATIVO'
            GROUP BY 1
            ORDER BY 2 DESC
            """
        ))
        especialidade_ds = label_rows(q(
            """
            SELECT COALESCE(NULLIF(ESPECIALIDADE, ''), 'SEM ESPECIALIDADE'), COUNT(DISTINCT UF_CRM)
            FROM GOLD.TB_ESPECIALIDADE_X_FONTES
            WHERE UPPER(SITUACAO) = 'ATIVO'
            GROUP BY 1
            ORDER BY 2 DESC
            LIMIT 12
            """
        ))
        especialidade_cfm = label_rows(q(
            """
            SELECT COALESCE(NULLIF(ESPECIALIDADE_RQE, ''), 'SEM ESPECIALIDADE'), COUNT(DISTINCT UF_CRM)
            FROM GOLD.TB_ESPECIALIDADE_X_FONTES
            WHERE UPPER(SITUACAO) = 'ATIVO'
            GROUP BY 1
            ORDER BY 2 DESC
            LIMIT 12
            """
        ))
        ufs = [{"uf": str(r[0]), "value": as_int([r[1]])} for r in q(
            """
            SELECT UF, COUNT(DISTINCT UF_CRM) AS N
            FROM GOLD.TB_MEDICOS
            WHERE UPPER(SITUACAO) = 'ATIVO' AND UF IS NOT NULL
            GROUP BY UF
            ORDER BY N DESC
            """
        ) if r and r[0]]
        regioes = {}
        for item in ufs:
            regioes[UF_REGIAO.get(item["uf"], "Outros")] = regioes.get(UF_REGIAO.get(item["uf"], "Outros"), 0) + item["value"]
        mensal = [{"mes": str(r[0]), "value": as_int([r[1]])} for r in q(
            """
            SELECT TO_CHAR(DATE_TRUNC('MONTH', COALESCE(
                     TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'),
                     TRY_TO_DATE(DT_INSCRICAO)
                   )), 'YYYY-MM') AS M,
                   COUNT(DISTINCT UF_CRM) AS N
            FROM GOLD.TB_ESPECIALIDADE_X_FONTES
            WHERE COALESCE(TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(DT_INSCRICAO))
                    >= DATEADD(MONTH, -35, DATE_TRUNC('MONTH', CURRENT_DATE()))
              AND COALESCE(TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(DT_INSCRICAO))
                    < DATEADD(MONTH, 1, DATE_TRUNC('MONTH', CURRENT_DATE()))
              AND YEAR(COALESCE(TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(DT_INSCRICAO)))
                    BETWEEN 2000 AND YEAR(CURRENT_DATE())
            GROUP BY 1
            ORDER BY 1
            """
        ) if r and r[0]]
        limite_mes = datetime.now().strftime("%Y-%m")
        mensal = [item for item in mensal if re.fullmatch(r"\d{4}-\d{2}", item["mes"] or "") and "2000" <= item["mes"][:4] <= limite_mes[:4] and item["mes"] <= limite_mes]
        cidades = [
            {"uf": str(r[0] or ""), "municipio": str(r[1] or ""), "ibge": str(r[2] or ""), "value": as_int([r[3]])}
            for r in q(
                """
                SELECT UF, MUNICIPIO, IBGE, N FROM (
                  SELECT UF, MUNICIPIO, IBGE, N,
                         ROW_NUMBER() OVER (PARTITION BY UF ORDER BY N DESC) AS RN
                  FROM (
                    SELECT UF, MUNICIPIO, IBGE,
                           COUNT(DISTINCT COALESCE(NULLIF(UF_CRM, ''), CPF)) AS N
                    FROM GOLD.TB_CNES_PROFISSIONAIS
                    WHERE CBO LIKE '225%' AND MUNICIPIO IS NOT NULL
                    GROUP BY 1, 2, 3
                  )
                )
                WHERE RN <= 40 OR UF = 'SP'
                ORDER BY N DESC
                """
            )
        ]
        payload = {
            "fonte": "dadosfera",
            "crm": as_int([kpis[0]]),
            "medicos": as_int([kpis[1]]),
            "especialidades": as_int([kpis[2]]),
            "atualizado_em": kpis[3],
            "genero": genero,
            "faixa": faixa,
            "especialidade_ds": especialidade_ds,
            "especialidade_cfm": especialidade_cfm,
            "ufs": ufs,
            "regioes": [{"label": k, "value": v} for k, v in sorted(regioes.items(), key=lambda x: -x[1])],
            "mensal": mensal,
            "cidades": cidades,
        }
        SNAPSHOT_BI = ROOT / "assets" / "snapshot-bi.json"
        SNAPSHOT_BI.write_text(json.dumps(payload, ensure_ascii=False, default=str, indent=2), encoding="utf-8")
        return payload
    finally:
        ctx.close()


def query_medicos_novos(override: dict | None = None) -> dict:
    cfg = merge_cfg(override)
    body = override or {}
    modo = "todos" if str(body.get("modo") or "").lower() == "todos" else "novos"
    mes = str(body.get("mes") or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}", mes):
        mes = datetime.now().strftime("%Y-%m")
    ano, mo = mes.split("-")
    uf = re.sub(r"[^A-Za-z]", "", str(body.get("uf") or "")).upper()[:2]
    municipio = re.sub(r"[^A-Za-zÀ-ÿ0-9 .\-']", "", str(body.get("municipio") or ""))[:80]
    ibge_digits = re.sub(r"\D", "", str(body.get("ibge") or ""))
    ibge = ibge_digits
    if modo == "todos" and not uf and not municipio and not ibge:
        return {
            "modo": modo,
            "mes": mes,
            "total": 0,
            "total_completo": 0,
            "linhas": [],
            "aviso": "Clique numa cidade no mapa para listar os médicos.",
        }

    city_filter = ""
    if uf:
        city_filter += f" AND p.UF = '{uf}'"
    if municipio:
        safe_mun = municipio.replace("'", "''")
        city_filter += f" AND UPPER(p.MUNICIPIO) = UPPER('{safe_mun}')"
    elif ibge_digits:
        ibge7 = ibge_digits.zfill(7)
        ibge6 = ibge_digits[:6] if len(ibge_digits) >= 6 else ibge_digits.zfill(6)
        city_filter += f""" AND (
          REGEXP_REPLACE(TO_VARCHAR(p.IBGE), '[^0-9]', '') IN ('{ibge_digits}', '{ibge6}', '{ibge7}')
          OR LEFT(LPAD(REGEXP_REPLACE(TO_VARCHAR(p.IBGE), '[^0-9]', ''), 7, '0'), 6) = '{ibge6}'
        )"""

    like = re.sub(r"[%_\\']", "", str(body.get("q") or body.get("busca") or "")).strip()[:80].upper()
    cidade_col = "COALESCE(c.MUNICIPIO, m.UF, '')" if city_filter else "COALESCE(m.UF, '')"
    busca_filter = ""
    if like:
        busca_filter = f"""
              AND (
                UPPER(m.NOME) LIKE '%{like}%'
                OR UPPER(m.UF_CRM) LIKE '%{like}%'
                OR UPPER(COALESCE(b.ESPECIALIDADE, '')) LIKE '%{like}%'
                OR UPPER(COALESCE(tel.TELEFONE, '')) LIKE '%{like}%'
                OR UPPER(COALESCE(em.EMAIL, '')) LIKE '%{like}%'
                OR UPPER({cidade_col}) LIKE '%{like}%'
              )
        """

    date_filter = ""
    if modo == "novos":
        date_filter = f"""
              AND b.DT_NOVO >= DATE_FROM_PARTS({int(ano)}, {int(mo)}, 1)
              AND b.DT_NOVO < DATEADD(MONTH, 1, DATE_FROM_PARTS({int(ano)}, {int(mo)}, 1))
        """
    join_base = "JOIN" if modo == "novos" else "LEFT JOIN"
    sem_cidade = modo == "novos" and str(body.get("sem_cidade") or "").lower() in {"1", "true", "sim"}

    if sem_cidade:
        sql = f"""
            WITH novos AS (
              SELECT UF_CRM,
                     MIN(COALESCE(TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(DT_INSCRICAO))) AS DT_NOVO,
                     MIN(COALESCE(NULLIF(ESPECIALIDADE, ''), NULLIF(ESPECIALIDADE_RQE, ''), 'SEM ESPECIALIDADE')) AS ESPECIALIDADE
              FROM GOLD.TB_ESPECIALIDADE_X_FONTES
              WHERE COALESCE(TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(DT_INSCRICAO))
                      >= DATE_FROM_PARTS({int(ano)}, {int(mo)}, 1)
                AND COALESCE(TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(DT_INSCRICAO))
                      < DATEADD(MONTH, 1, DATE_FROM_PARTS({int(ano)}, {int(mo)}, 1))
              GROUP BY UF_CRM
            ),
            cid AS (
              SELECT p.UF_CRM
              FROM novos n
              JOIN GOLD.TB_CNES_PROFISSIONAIS p ON p.UF_CRM = n.UF_CRM
              WHERE NULLIF(p.MUNICIPIO, '') IS NOT NULL
              QUALIFY ROW_NUMBER() OVER (PARTITION BY p.UF_CRM ORDER BY p.UPDATE_DATE DESC NULLS LAST) = 1
            )
            SELECT COALESCE(m.UF_CRM, n.UF_CRM), COALESCE(m.NOME, ''),
                   'Sem cidade · ' || COALESCE(m.UF, LEFT(n.UF_CRM, 2)),
                   COALESCE(m.UF, LEFT(n.UF_CRM, 2)), tel.TELEFONE, em.EMAIL,
                   TO_CHAR(n.DT_NOVO, 'YYYY-MM-DD'), n.ESPECIALIDADE, COUNT(*) OVER()
            FROM novos n
            LEFT JOIN cid c ON c.UF_CRM = n.UF_CRM
            LEFT JOIN GOLD.TB_MEDICOS m ON m.UF_CRM = n.UF_CRM
            LEFT JOIN (
              SELECT UF_CRM, TELEFONE
              FROM GOLD.TB_MEDICOS_TELEFONES_FREQUENCIA
              QUALIFY ROW_NUMBER() OVER (PARTITION BY UF_CRM ORDER BY QTDE_REPETICOES DESC NULLS LAST) = 1
            ) tel ON tel.UF_CRM = n.UF_CRM
            LEFT JOIN (
              SELECT UF_CRM, EMAIL
              FROM GOLD.TB_MEDICOS_EMAILS_FREQUENCIA
              QUALIFY ROW_NUMBER() OVER (PARTITION BY UF_CRM ORDER BY QTDE_REPETICOES DESC NULLS LAST) = 1
            ) em ON em.UF_CRM = n.UF_CRM
            WHERE c.UF_CRM IS NULL
              AND COALESCE(m.UF, LEFT(n.UF_CRM, 2)) = '{uf}'
              {("AND (UPPER(COALESCE(m.NOME, '')) LIKE '%%%s%%' OR UPPER(n.UF_CRM) LIKE '%%%s%%' OR UPPER(COALESCE(n.ESPECIALIDADE, '')) LIKE '%%%s%%')" % (like, like, like)) if like else ""}
            ORDER BY COALESCE(m.NOME, n.UF_CRM)
            LIMIT 8000
        """
    elif city_filter:
        sql = f"""
            WITH cid AS (
              SELECT UF_CRM, MUNICIPIO, UF, IBGE
              FROM GOLD.TB_CNES_PROFISSIONAIS p
              WHERE NULLIF(UF_CRM, '') IS NOT NULL
                AND MUNICIPIO IS NOT NULL
                {city_filter}
              QUALIFY ROW_NUMBER() OVER (PARTITION BY UF_CRM ORDER BY UPDATE_DATE DESC NULLS LAST) = 1
            ),
            base AS (
              SELECT UF_CRM,
                     MIN(COALESCE(TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(DT_INSCRICAO))) AS DT_NOVO,
                     MIN(COALESCE(NULLIF(ESPECIALIDADE, ''), NULLIF(ESPECIALIDADE_RQE, ''), 'SEM ESPECIALIDADE')) AS ESPECIALIDADE
              FROM GOLD.TB_ESPECIALIDADE_X_FONTES
              GROUP BY UF_CRM
            )
            SELECT m.UF_CRM, m.NOME, c.MUNICIPIO, COALESCE(c.UF, m.UF), tel.TELEFONE, em.EMAIL,
                   TO_CHAR(b.DT_NOVO, 'YYYY-MM-DD'), b.ESPECIALIDADE, COUNT(*) OVER()
            FROM GOLD.TB_MEDICOS m
            JOIN cid c ON c.UF_CRM = m.UF_CRM
            {join_base} base b ON b.UF_CRM = m.UF_CRM
            LEFT JOIN (
              SELECT UF_CRM, TELEFONE
              FROM GOLD.TB_MEDICOS_TELEFONES_FREQUENCIA
              QUALIFY ROW_NUMBER() OVER (PARTITION BY UF_CRM ORDER BY QTDE_REPETICOES DESC NULLS LAST) = 1
            ) tel ON tel.UF_CRM = m.UF_CRM
            LEFT JOIN (
              SELECT UF_CRM, EMAIL
              FROM GOLD.TB_MEDICOS_EMAILS_FREQUENCIA
              QUALIFY ROW_NUMBER() OVER (PARTITION BY UF_CRM ORDER BY QTDE_REPETICOES DESC NULLS LAST) = 1
            ) em ON em.UF_CRM = m.UF_CRM
            WHERE UPPER(m.SITUACAO) = 'ATIVO'
              {date_filter}
              {busca_filter}
            ORDER BY m.NOME
            LIMIT 8000
        """
    else:
        sql = f"""
            WITH base AS (
              SELECT UF_CRM,
                     MIN(COALESCE(TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(DT_INSCRICAO))) AS DT_NOVO,
                     MIN(COALESCE(NULLIF(ESPECIALIDADE, ''), NULLIF(ESPECIALIDADE_RQE, ''), 'SEM ESPECIALIDADE')) AS ESPECIALIDADE
              FROM GOLD.TB_ESPECIALIDADE_X_FONTES
              GROUP BY UF_CRM
            )
            SELECT m.UF_CRM, m.NOME, NULL, m.UF, tel.TELEFONE, em.EMAIL, TO_CHAR(b.DT_NOVO, 'YYYY-MM-DD'), b.ESPECIALIDADE, COUNT(*) OVER()
            FROM GOLD.TB_MEDICOS m
            JOIN base b ON b.UF_CRM = m.UF_CRM
            LEFT JOIN (
              SELECT UF_CRM, TELEFONE
              FROM GOLD.TB_MEDICOS_TELEFONES_FREQUENCIA
              QUALIFY ROW_NUMBER() OVER (PARTITION BY UF_CRM ORDER BY QTDE_REPETICOES DESC NULLS LAST) = 1
            ) tel ON tel.UF_CRM = m.UF_CRM
            LEFT JOIN (
              SELECT UF_CRM, EMAIL
              FROM GOLD.TB_MEDICOS_EMAILS_FREQUENCIA
              QUALIFY ROW_NUMBER() OVER (PARTITION BY UF_CRM ORDER BY QTDE_REPETICOES DESC NULLS LAST) = 1
            ) em ON em.UF_CRM = m.UF_CRM
            WHERE UPPER(m.SITUACAO) = 'ATIVO'
              {date_filter}
              {busca_filter}
            ORDER BY m.NOME
            LIMIT 8000
        """

    ctx = connect_snowflake(cfg)
    warehouse = (cfg.get("snowflake_warehouse") or "COMPUTE_WH").strip()
    try:
        cur = ctx.cursor()
        cur.execute(f"USE WAREHOUSE {warehouse}")
        cur.execute("USE DATABASE DADOSFERA_PRD_DIGITALSOLVERS")
        cur.close()
        rows = snowflake_fetch(ctx, sql)[1]
        lista = [
            {
                "uf_crm": str(r[0] or ""),
                "nome": str(r[1] or ""),
                "cidade": str(r[2] or ""),
                "uf": str(r[3] or ""),
                "telefone": str(r[4] or ""),
                "email": str(r[5] or ""),
                "data": str(r[6] or ""),
                "especialidade": str(r[7] or ""),
            }
            for r in rows
        ]
        total_completo = as_int([rows[0][8]]) if rows else 0
        return {
            "modo": modo,
            "mes": mes,
            "uf": uf,
            "municipio": municipio,
            "ibge": ibge,
            "total": len(lista),
            "total_completo": total_completo or len(lista),
            "linhas": lista,
        }
    finally:
        ctx.close()


def query_cidades_novos(override: dict | None = None) -> dict:
    cfg = merge_cfg(override)
    body = override or {}
    mes = str(body.get("mes") or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}", mes):
        mes = datetime.now().strftime("%Y-%m")
    ano, mo = mes.split("-")
    sql = f"""
        WITH novos AS (
          SELECT UF_CRM
          FROM GOLD.TB_ESPECIALIDADE_X_FONTES
          WHERE COALESCE(TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(DT_INSCRICAO))
                  >= DATE_FROM_PARTS({int(ano)}, {int(mo)}, 1)
            AND COALESCE(TRY_TO_DATE(DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(DT_INSCRICAO))
                  < DATEADD(MONTH, 1, DATE_FROM_PARTS({int(ano)}, {int(mo)}, 1))
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
          COALESCE(NULLIF(c.UF, ''), m.UF, LEFT(n.UF_CRM, 2)) AS UF,
          COALESCE(NULLIF(c.MUNICIPIO, ''), 'Sem cidade · ' || COALESCE(NULLIF(c.UF, ''), m.UF, LEFT(n.UF_CRM, 2))) AS MUNICIPIO,
          COALESCE(TO_VARCHAR(c.IBGE), '') AS IBGE,
          COUNT(DISTINCT n.UF_CRM) AS N,
          IFF(NULLIF(c.MUNICIPIO, '') IS NULL, 1, 0) AS SEM_CIDADE
        FROM novos n
        LEFT JOIN cid c ON c.UF_CRM = n.UF_CRM
        LEFT JOIN GOLD.TB_MEDICOS m ON m.UF_CRM = n.UF_CRM
        GROUP BY 1, 2, 3, 5
        ORDER BY N DESC
    """
    ctx = connect_snowflake(cfg)
    warehouse = (cfg.get("snowflake_warehouse") or "COMPUTE_WH").strip()
    try:
        cur = ctx.cursor()
        cur.execute(f"USE WAREHOUSE {warehouse}")
        cur.execute("USE DATABASE DADOSFERA_PRD_DIGITALSOLVERS")
        cur.close()
        rows = snowflake_fetch(ctx, sql)[1]
        cidades = [
            {
                "uf": str(r[0] or "").upper(),
                "municipio": str(r[1] or ""),
                "ibge": str(r[2] or ""),
                "value": as_int([r[3]]),
                "sem_cidade": as_int([r[4]]) == 1,
            }
            for r in rows
            if r and r[0] and r[1]
        ]
        return {
            "mes": mes,
            "cidades": cidades,
            "total": len(cidades),
            "medicos": sum(c["value"] for c in cidades),
        }
    finally:
        ctx.close()


def _cnes_setor(natureza, grupo) -> str:
    g = str(grupo or "").upper()
    if g.startswith("1") or "ADMINISTRA" in g:
        return "Público"
    if g.startswith("2") or g.startswith("3") or "EMPRESAR" in g or "PRIVAD" in g:
        return "Privado"
    digits = re.sub(r"\D", "", str(natureza or ""))
    if digits[:1] == "1":
        return "Público"
    if digits[:1] in {"2", "3"}:
        return "Privado"
    return "Não informado"


CNES_NOME_COMUM = {
    "ANA", "ANDRE", "ANTONIO", "BRUNO", "CARLOS", "DANIEL", "DIEGO", "EDUARDO",
    "FELIPE", "FERNANDO", "FRANCISCO", "GABRIEL", "GUSTAVO", "JOAO", "JOSE",
    "LEONARDO", "LUCAS", "LUIZ", "MARCOS", "MARIA", "MATEUS", "MATHEUS",
    "PAULA", "PAULO", "PEDRO", "RAFAEL", "RICARDO", "RODRIGO", "THIAGO", "TIAGO",
}


def _cnes_busca_parse(q: str) -> dict:
    like = re.sub(r"[%_\\']", "", q)[:80].upper()
    compact = re.sub(r"\s", "", like)
    digits = re.sub(r"\D", "", q)[:15]
    tokens = [t for t in re.split(r"[\s,;./-]+", like) if len(t) >= 2 and not t.isdigit()][:6]
    is_crm = bool(re.match(r"^[A-Z]{2}\d{3,}", compact)) or bool(re.fullmatch(r"\d{4,8}[A-Z]?", compact))
    return {"compact": compact, "digits": digits, "tokens": tokens, "is_crm": is_crm}


def _cnes_allow_blank_crm(tokens: list[str]) -> bool:
    return any(len(t) >= 5 and t not in CNES_NOME_COMUM for t in tokens)


def _cnes_name_sql(alias: str, tokens: list[str], col: str = "NOME") -> str:
    if not tokens:
        return "1=1"
    return " AND ".join(f"UPPER({alias}.{col}) LIKE '%{t}%'" for t in tokens)


def _cnes_cidade(value) -> str:
    return re.sub(r"^\d+\s*[-–]\s*", "", str(value or "")).strip()


def _cnes_fmt_comp(value) -> str:
    raw = str(value or "").strip()
    if re.fullmatch(r"\d{4}-\d{2}", raw):
        return raw
    digits = re.sub(r"\D", "", raw)
    if len(digits) >= 6:
        return f"{digits[:4]}-{digits[4:6]}"
    return raw


def _cnes_novos_sql(alias: str, ano: int, mo: int) -> str:
    return f"""
        AND EXISTS (
          SELECT 1 FROM GOLD.TB_ESPECIALIDADE_X_FONTES nv
          WHERE nv.UF_CRM = {alias}.UF_CRM
            AND COALESCE(TRY_TO_DATE(nv.DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(nv.DT_INSCRICAO))
                  >= DATE_FROM_PARTS({ano}, {mo}, 1)
            AND COALESCE(TRY_TO_DATE(nv.DT_INSCRICAO, 'DD/MM/YYYY'), TRY_TO_DATE(nv.DT_INSCRICAO))
                  < DATEADD(MONTH, 1, DATE_FROM_PARTS({ano}, {mo}, 1))
        )
    """


def _cnes_medicos_sql(parsed: dict, uf: str, novos: bool, ano: int, mo: int) -> str:
    compact = parsed["compact"][:20]
    digits = re.sub(r"\D", "", parsed["digits"] or compact)[:20]
    tokens = parsed["tokens"]
    parts = []
    if parsed["is_crm"]:
        parts.append(f"(m.UF_CRM = '{compact}' OR m.UF_CRM ILIKE '%{digits}')")
    elif tokens:
        parts.append(f"({_cnes_name_sql('m', tokens, 'NOME')})")
    where = " OR ".join(parts) if parts else "1=0"
    uf_sql = f"AND m.UF_CRM ILIKE '{uf}%'" if uf else ""
    novos_sql = _cnes_novos_sql("m", ano, mo) if novos else ""
    return f"""
        SELECT m.UF_CRM, m.NOME,
          IFF(LENGTH(REGEXP_REPLACE(TO_VARCHAR(m.CPF), '[^0-9]', '')) >= 11,
              LOWER(SHA2(REGEXP_REPLACE(TO_VARCHAR(m.CPF), '[^0-9]', ''), 256)), NULL)
        FROM GOLD.TB_MEDICOS m
        WHERE ({where})
          {uf_sql}
          {novos_sql}
        QUALIFY DENSE_RANK() OVER (ORDER BY m.NOME, m.UF_CRM) <= 40
    """


def _cnes_busca_sql(parsed: dict, uf: str, novos: bool, ano: int, mo: int, allow_blank: bool = False, uf_crms: list | None = None, hashes: list | None = None) -> str:
    compact = parsed["compact"][:20]
    digits = re.sub(r"\D", "", parsed["digits"] or compact)[:20]
    tokens = parsed["tokens"]
    parts = []
    if parsed["is_crm"]:
        if re.match(r"^[A-Z]{2}", compact):
            parts.append(f"c.UF_CRM = '{compact}'")
        else:
            parts.append(f"(c.UF_CRM ILIKE '%{digits}' OR TO_VARCHAR(c.CRM) = '{digits}')")
    elif tokens:
        parts.append(f"({_cnes_name_sql('c', tokens, 'NOME_PROFISSIONAL')})")
    if len(parsed["digits"]) >= 8 and len(parsed["digits"]) != 11:
        parts.append(f"TO_VARCHAR(c.CNS) LIKE '%{parsed['digits']}%'")
    safe_crms = [re.sub(r"[^A-Za-z0-9]", "", str(v)) for v in (uf_crms or []) if re.sub(r"[^A-Za-z0-9]", "", str(v))][:40]
    safe_hashes = [str(v).lower() for v in (hashes or []) if re.fullmatch(r"[a-f0-9]{64}", str(v).lower())][:40]
    crm_nums = sorted({re.sub(r"\D", "", v) for v in safe_crms if re.sub(r"\D", "", v)})
    if safe_crms:
        parts.append("c.UF_CRM IN (" + ",".join(f"'{v}'" for v in safe_crms) + ")")
    if safe_hashes and crm_nums:
        parts.append(
            "(REGEXP_REPLACE(TO_VARCHAR(c.UF_CRM), '[^0-9]', '') IN ("
            + ",".join(f"'{v}'" for v in crm_nums)
            + ") AND IFF(LENGTH(REGEXP_REPLACE(TO_VARCHAR(c.CPF), '[^0-9]', '')) >= 11, "
            + "LOWER(SHA2(REGEXP_REPLACE(TO_VARCHAR(c.CPF), '[^0-9]', ''), 256)), NULL) IN ("
            + ",".join(f"'{v}'" for v in safe_hashes)
            + "))"
        )
    where = " OR ".join(parts) if parts else "1=0"
    blank_sql = " OR 1=1" if allow_blank else ""
    novos_sql = _cnes_novos_sql("c", ano, mo) if novos else ""
    uf_sql = f"AND (c.UF_ESTABELECIMENTO = '{uf}' OR c.UF_CRM ILIKE '{uf}%')" if uf else ""
    return f"""
        SELECT
          c.UF_CRM, c.NOME_PROFISSIONAL,
          IFF(LENGTH(REGEXP_REPLACE(TO_VARCHAR(c.CPF), '[^0-9]', '')) >= 11,
              LOWER(SHA2(REGEXP_REPLACE(TO_VARCHAR(c.CPF), '[^0-9]', ''), 256)),
              NULL),
          c.CNS, c.CRM, c.CBO, c.CNES,
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
        WHERE ({where})
          AND (NULLIF(c.UF_CRM, '') IS NOT NULL{blank_sql})
          {uf_sql}
          {novos_sql}
        QUALIFY ROW_NUMBER() OVER (
          PARTITION BY COALESCE(NULLIF(c.UF_CRM, ''), TO_VARCHAR(c.CNS), c.NOME_PROFISSIONAL),
            COALESCE(TO_VARCHAR(c.CNES), c.ESTABELECIMENTO), COALESCE(c.CBO, ''),
            TO_VARCHAR(c.ANOMES)
          ORDER BY c.UPDATE_DATE DESC NULLS LAST
        ) = 1
        AND DENSE_RANK() OVER (
          PARTITION BY COALESCE(NULLIF(c.UF_CRM, ''), TO_VARCHAR(c.CNS), c.NOME_PROFISSIONAL)
          ORDER BY TO_VARCHAR(c.ANOMES) DESC NULLS LAST
        ) <= 18
        AND DENSE_RANK() OVER (ORDER BY c.NOME_PROFISSIONAL, c.UF_CRM) <= 40
        ORDER BY c.NOME_PROFISSIONAL, TRY_TO_DOUBLE(TO_VARCHAR(c.CH_TOTAL)) DESC NULLS LAST
    """


def _cnes_digits(value) -> str:
    return re.sub(r"\D", "", str(value or ""))


def _cnes_uf_crm(uf_crm) -> str:
    return re.sub(r"[^A-Za-z]", "", str(uf_crm or "")).upper()[:2]


def _cnes_hash_cpf(value) -> str:
    digits = _cnes_digits(value)
    if len(digits) < 11:
        return ""
    return hashlib.sha256(digits.encode("utf-8")).hexdigest()


def _cnes_pessoa_key(item: dict) -> str:
    hashed = str(item.get("cpf_hash") or "").strip().lower()
    if len(hashed) == 64 and re.fullmatch(r"[a-f0-9]{64}", hashed):
        return f"id:{hashed}"
    plain = _cnes_hash_cpf(item.get("cpf"))
    if plain:
        return f"id:{plain}"
    cns = _cnes_digits(item.get("cns"))
    if len(cns) >= 14:
        return f"cns:{cns}"
    nome = str(item.get("nome") or "").strip().upper()
    crm = _cnes_digits(item.get("crm")) or re.sub(r"^[A-Za-z]{2}", "", str(item.get("uf_crm") or ""))
    return f"crm:{nome}::{crm}"


def _cnes_public_id(item: dict, grouped_id: str, medico: dict | None = None) -> str:
    if medico and medico.get("uf_crm"):
        return f"crm:{medico['uf_crm']}"
    cns = _cnes_digits(item.get("cns"))
    if len(cns) >= 14:
        return f"cns:{cns}"
    crm = str(item.get("uf_crm") or "").strip()
    return f"crm:{crm}" if crm else grouped_id


def _cnes_public_vinculo(item: dict, public_id: str, uf_crm: str, nome: str = "") -> dict:
    return {
        "pessoa_id": public_id,
        "uf_crm": uf_crm,
        "nome": nome or item.get("nome") or "",
        "cns": item.get("cns") or "",
        "crm": item.get("crm") or "",
        "cbo": item.get("cbo") or "",
        "cnes": item.get("cnes") or "",
        "estabelecimento": item.get("estabelecimento") or "",
        "municipio": item.get("municipio") or "",
        "uf": item.get("uf") or "",
        "horas_total": item.get("horas_total") or 0,
        "competencia": _cnes_fmt_comp(item.get("competencia")),
    }


def _cnes_horas_cbo(rows: list[dict]) -> list[dict]:
    by_cbo: dict[str, dict] = {}
    for item in rows:
        label = str(item.get("cbo") or "Sem CBO").strip() or "Sem CBO"
        cur = by_cbo.setdefault(label, {"cbo": label, "horas": 0, "vinculos": 0, "estabelecimento": item.get("estabelecimento") or "", "_max": -1})
        horas = item.get("horas_total") or 0
        cur["horas"] += horas
        cur["vinculos"] += 1
        if horas >= cur["_max"]:
            cur["_max"] = horas
            cur["estabelecimento"] = item.get("estabelecimento") or cur["estabelecimento"]
    out = []
    for cur in by_cbo.values():
        cur.pop("_max", None)
        out.append(cur)
    out.sort(key=lambda x: (-x["horas"], x["cbo"]))
    return out


def _cnes_agrupar(vinculos: list[dict], medicos: list[dict] | None = None) -> tuple[list[dict], list[dict]]:
    by_hash = {}
    by_crm = {}
    for medico in medicos or []:
        hashed = str(medico.get("cpf_hash") or "").lower()
        if re.fullmatch(r"[a-f0-9]{64}", hashed):
            by_hash[hashed] = medico
        if medico.get("uf_crm"):
            by_crm[str(medico["uf_crm"]).upper()] = medico
    groups: dict[str, list] = {}
    for item in vinculos:
        groups.setdefault(_cnes_pessoa_key(item), []).append(item)
    profissionais = []
    filtrados = []
    for pessoa_id, rows in groups.items():
        medico = by_hash.get(str((rows[0] or {}).get("cpf_hash") or "").lower())
        if not medico:
            for item in rows:
                medico = by_crm.get(str(item.get("uf_crm") or "").upper())
                if medico:
                    break
        by_uf: dict[str, dict] = {}
        for item in rows:
            uf = _cnes_uf_crm(item.get("uf_crm")) or "_"
            cur = by_uf.setdefault(uf, {"horas": 0, "n": 0, "uf_crm": item.get("uf_crm")})
            cur["horas"] += item.get("horas_total") or 0
            cur["n"] += 1
        if medico:
            canon = {"uf_crm": medico["uf_crm"], "horas": 0, "n": 0}
        elif by_uf:
            canon = max(by_uf.values(), key=lambda info: (info["horas"], info["n"]))
        else:
            canon = {"uf_crm": (rows[0] or {}).get("uf_crm") or "", "horas": 0, "n": 0}
        kept = rows
        nome = (medico or {}).get("nome") or kept[0]["nome"]
        public_id = _cnes_public_id(kept[0], pessoa_id, medico)
        horas_cbo = _cnes_horas_cbo(kept)
        competencias: set[str] = set()
        doc = {
            "pessoa_id": public_id, "uf_crm": canon["uf_crm"], "nome": nome,
            "cns": kept[0]["cns"], "crm": kept[0].get("crm") or re.sub(r"^[A-Za-z]{2}", "", str(canon["uf_crm"] or "")),
            "uf": kept[0]["uf"],
            "horas_total": 0, "vinculos": 0, "estabelecimento": kept[0]["estabelecimento"],
            "setor": kept[0]["setor"], "cidades": set(), "horas_cbo": horas_cbo, "_max": -1, "principal_cnes": "",
        }
        for item in kept:
            pub = _cnes_public_vinculo(item, public_id, canon["uf_crm"], nome)
            filtrados.append(pub)
            doc["horas_total"] += pub["horas_total"]
            doc["vinculos"] += 1
            if pub.get("competencia"):
                competencias.add(pub["competencia"])
            if pub["municipio"]:
                doc["cidades"].add(f"{pub['municipio']}/{pub['uf']}")
            if pub["horas_total"] >= doc["_max"]:
                doc["_max"] = pub["horas_total"]
                doc["estabelecimento"] = pub["estabelecimento"]
                doc["setor"] = item.get("setor")
                doc["principal_cnes"] = pub["cnes"]
                doc["uf"] = pub["uf"]
        profissionais.append({
            "pessoa_id": doc["pessoa_id"], "uf_crm": doc["uf_crm"], "nome": doc["nome"],
            "cns": doc["cns"], "crm": doc["crm"], "uf": doc["uf"],
            "horas_total": doc["horas_total"], "vinculos": doc["vinculos"],
            "estabelecimento": doc["estabelecimento"], "setor": doc["setor"],
            "cidades": sorted(doc["cidades"]), "competencias": sorted(competencias),
            "horas_cbo": doc["horas_cbo"],
            "principal_cnes": doc.get("principal_cnes") or "",
        })
    return profissionais, filtrados


def _cnes_merge_medicos(profissionais: list[dict], medicos: list[dict]) -> list[dict]:
    seen = {str(p.get("uf_crm") or "").upper() for p in profissionais if p.get("uf_crm")}
    for medico in medicos:
        key = str(medico.get("uf_crm") or "").upper()
        if not key or key in seen:
            continue
        seen.add(key)
        profissionais.append({
            "pessoa_id": f"crm:{medico['uf_crm']}",
            "uf_crm": medico["uf_crm"],
            "nome": medico.get("nome") or "",
            "cns": "",
            "crm": re.sub(r"^[A-Za-z]{2}", "", str(medico.get("uf_crm") or "")),
            "uf": _cnes_uf_crm(medico.get("uf_crm")),
            "horas_total": 0,
            "vinculos": 0,
            "estabelecimento": "",
            "setor": "—",
            "cidades": [],
            "competencias": [],
            "horas_cbo": [],
            "principal_cnes": "",
        })
    profissionais.sort(key=lambda p: str(p.get("nome") or ""))
    return profissionais


def query_cnes_busca(override: dict | None = None) -> dict:
    cfg = merge_cfg(override)
    body = override or {}
    q = str(body.get("q") or "").strip()
    if len(re.sub(r"\s", "", q)) < 3:
        return {"aviso": "Digite pelo menos 3 caracteres: nome, CRM ou CNS.", "profissionais": [], "vinculos": []}
    parsed = _cnes_busca_parse(q)
    if not parsed["tokens"] and not parsed["is_crm"] and len(parsed["digits"]) == 11:
        return {"aviso": "Por proteção de dados a busca não usa CPF. Pesquise por nome, CRM ou CNS.", "profissionais": [], "vinculos": []}
    uf = re.sub(r"[^A-Za-z]", "", str(body.get("uf") or "")).upper()[:2]
    novos = str(body.get("novos") or "").lower() in {"1", "true", "sim"}
    mes = str(body.get("mes") or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}", mes):
        mes = datetime.now().strftime("%Y-%m")
    ano, mo = (int(x) for x in mes.split("-"))
    ctx = connect_snowflake(cfg)
    warehouse = (cfg.get("snowflake_warehouse") or "COMPUTE_WH").strip()
    try:
        cur = ctx.cursor()
        cur.execute(f"USE WAREHOUSE {warehouse}")
        cur.execute("USE DATABASE DADOSFERA_PRD_DIGITALSOLVERS")
        cur.close()
        allow_blank = _cnes_allow_blank_crm(parsed["tokens"])
        med_rows = snowflake_fetch(ctx, _cnes_medicos_sql(parsed, uf, novos, ano, mo))[1]
        medicos = []
        for r in med_rows:
            medicos.append({
                "uf_crm": str(r[0] or ""),
                "nome": str(r[1] or ""),
                "cpf_hash": str(r[2] or "").lower(),
            })
        rows = snowflake_fetch(ctx, _cnes_busca_sql(
            parsed, uf, novos, ano, mo, allow_blank,
            [m["uf_crm"] for m in medicos],
            [m["cpf_hash"] for m in medicos],
        ))[1]
        vinculos = []
        for r in rows:
            natureza = str(r[9] or "")
            grupo = str(r[32] or "")
            item = {
                "uf_crm": str(r[0] or ""),
                "nome": str(r[1] or ""),
                "cpf_hash": str(r[2] or "").lower(),
                "cns": str(r[3] or ""),
                "crm": str(r[4] or ""),
                "cbo": str(r[5] or ""),
                "cnes": str(r[6] or ""),
                "estabelecimento": str(r[22] or r[7] or ""),
                "cnpj": str(r[8] or ""),
                "natureza": natureza,
                "gestao": str(r[10] or ""),
                "sus": str(r[11] or ""),
                "vinculo": str(r[12] or ""),
                "empregador": str(r[13] or ""),
                "horas_outros": as_int([r[14]]),
                "horas_amb": as_int([r[15]]),
                "horas_hosp": as_int([r[16]]),
                "horas_total": as_int([r[17]]),
                "municipio": _cnes_cidade(r[27] or r[18] or ""),
                "uf": str(r[28] or r[19] or ""),
                "ibge": str(r[20] or ""),
                "turno": str(r[21] or ""),
                "endereco": ", ".join(str(x) for x in (r[23], r[24], r[25]) if x),
                "bairro": str(r[26] or ""),
                "cep": str(r[29] or ""),
                "telefone": str(r[30] or ""),
                "email": str(r[31] or ""),
                "grupo": grupo,
                "tipo": str(r[33] or ""),
                "unidade": str(r[34] or ""),
                "competencia": str(r[35] or ""),
                "setor": _cnes_setor(natureza, grupo),
            }
            vinculos.append(item)
        profissionais, vinculos = _cnes_agrupar(vinculos, medicos)
        profissionais = _cnes_merge_medicos(profissionais, medicos)
        aviso = ""
        if not profissionais:
            aviso = (
                "Nenhum médico novo deste mês corresponde à busca. Desmarque a opção para consultar a base completa."
                if novos else "Nenhum profissional encontrado no CNES para essa busca."
            )
        return {"q": q, "mes": mes, "novos": novos, "total": len(profissionais), "aviso": aviso, "profissionais": profissionais, "vinculos": vinculos}
    finally:
        ctx.close()

def normalize_host(host: str) -> str:
    host = (host or "").strip().rstrip("/")
    host = host.replace("https://", "").replace("http://", "")
    return host


def databricks_request(host: str, token: str, path: str, payload: dict | None = None, method: str = "GET"):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = Request(
        f"https://{host}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    context = ssl.create_default_context()
    try:
        with urlopen(req, timeout=60, context=context) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Databricks HTTP {exc.code}: {detail[:400]}") from exc
    except URLError as exc:
        raise RuntimeError(f"Não alcancei o Databricks: {exc.reason}") from exc


def databricks_sql(cfg: dict, statement: str) -> list[list]:
    host = normalize_host(cfg.get("databricks_host") or cfg.get("host") or "")
    token = (cfg.get("databricks_token") or cfg.get("token") or "").strip()
    warehouse_id = (cfg.get("databricks_warehouse_id") or cfg.get("warehouse_id") or "").strip()
    if not host or not token:
        raise RuntimeError("Databricks sem host/token.")
    if not warehouse_id:
        warehouses = databricks_request(host, token, "/api/2.0/sql/warehouses")
        items = warehouses.get("warehouses") or []
        if not items:
            raise RuntimeError("Nenhum SQL warehouse no Databricks.")
        warehouse_id = items[0].get("id") or ""
    data = databricks_request(
        host,
        token,
        "/api/2.0/sql/statements",
        {
            "warehouse_id": warehouse_id,
            "statement": statement,
            "wait_timeout": "50s",
            "on_wait_timeout": "CONTINUE",
            "disposition": "INLINE",
        },
        method="POST",
    )
    started = time.time()
    while (data.get("status") or {}).get("state") in {"PENDING", "RUNNING"}:
        if time.time() - started > 120:
            raise RuntimeError("A consulta no Databricks demorou demais.")
        time.sleep(1.5)
        data = databricks_request(host, token, f"/api/2.0/sql/statements/{data.get('statement_id')}")
    if (data.get("status") or {}).get("state") == "FAILED":
        raise RuntimeError((data.get("status") or {}).get("error", {}).get("message") or "Query Databricks falhou")
    return ((data.get("result") or {}).get("data_array")) or []


def query_databricks(override: dict | None = None) -> dict:
    cfg = merge_cfg(override)
    catalog = cfg.get("databricks_catalog") or "dev"
    table = f"{catalog}.gold.{cfg.get('databricks_table') or 'tb_medicos'}"
    custom = (override or {}).get("sql") or cfg.get("databricks_sql")
    if custom:
        rows = databricks_sql(cfg, custom)
        return {"valor": as_int(rows), "fonte": "databricks", "tabela": table, "linhas": rows[:40]}

    def scalar_int(sql: str) -> int:
        return as_int(databricks_sql(cfg, sql))

    def scalar_date(sql: str):
        try:
            rows = databricks_sql(cfg, sql)
            if rows and rows[0] and rows[0][0] not in (None, ""):
                return rows[0][0]
        except Exception:
            return None
        return None

    crm_unicos = scalar_int(
        f"""
        SELECT COUNT(DISTINCT uf_crm) AS CRM_UNICOS
        FROM {table}
        WHERE UPPER(situacao) = 'ATIVO'
        """
    )
    cpf_unicos = scalar_int(
        f"""
        SELECT COUNT(DISTINCT cpf) AS TOTAL_CPFS
        FROM {table}
        WHERE UPPER(situacao) = 'ATIVO'
        """
    )
    total_medicos = scalar_int(
        f"""
        SELECT COUNT(*) AS TOTAL_MEDICOS
        FROM {table}
        WHERE UPPER(situacao) = 'ATIVO'
        """
    )
    total_registros = scalar_int(
        f"""
        SELECT COUNT(DISTINCT uf_crm) AS TOTAL_UF_CRMS
        FROM {table}
        WHERE 1=1
        """
    )

    atualizado_gold = scalar_date(f"SELECT MAX(update_date) AS ULTIMA_ATUALIZACAO FROM {table}")
    atualizado_cfm = scalar_date(
        f"SELECT MAX(update_date) AS ULTIMA_ATUALIZACAO_CFM FROM {catalog}.silver.tb_cfm"
    ) or atualizado_gold
    atualizado_cnes = (
        scalar_date(f"SELECT MAX(update_date) FROM {catalog}.silver.tb_cnes_profissionais")
        or atualizado_gold
    )

    ufs = []
    try:
        urows = databricks_sql(
            cfg,
            f"""
            SELECT uf, COUNT(DISTINCT uf_crm) AS n
            FROM {table}
            WHERE UPPER(situacao) = 'ATIVO'
            GROUP BY uf
            ORDER BY n DESC
            LIMIT 12
            """,
        )
        ufs = [{"uf": str(r[0]), "value": as_int([r[1]])} for r in urows if r and r[0] is not None]
    except Exception:
        ufs = []

    genero = []
    try:
        grows = databricks_sql(
            cfg,
            f"""
            SELECT COALESCE(genero, 'Não informado') AS genero, COUNT(*) AS qtd_medicos
            FROM {table}
            WHERE UPPER(situacao) = 'ATIVO'
            GROUP BY genero
            ORDER BY qtd_medicos DESC
            """,
        )
        genero = [{"label": str(r[0] or "Não informado"), "value": as_int([r[1]])} for r in grows]
    except Exception:
        genero = []

    tipo = []
    try:
        trows = databricks_sql(
            cfg,
            f"""
            SELECT tipo_inscricao, COUNT(*) AS qtd_medicos
            FROM {table}
            WHERE UPPER(situacao) = 'ATIVO'
            GROUP BY tipo_inscricao
            ORDER BY qtd_medicos DESC
            """,
        )
        tipo = [{"label": str(r[0] or "Other"), "value": as_int([r[1]])} for r in trows]
    except Exception:
        tipo = []

    extras = [
        {"label": "Databricks · CRMs únicos ativos", "value": crm_unicos, "accent": True},
        {"label": "Databricks · CPFs únicos ativos", "value": cpf_unicos},
        {"label": "Databricks · Total médicos ativos", "value": total_medicos},
        {"label": "Databricks · Total registros", "value": total_registros},
    ]

    bronze = 0
    for bronze_table in (
        f"{catalog}.bronze.db_d2p_43_cnes_profissionais",
        f"{catalog}.bronze.tb_cnes_profissionais",
        f"{catalog}.bronze.db_d2p_72_cnes_profissionais_202503_cbos",
    ):
        try:
            bronze = scalar_int(
                f"""
                SELECT COUNT(DISTINCT regexp_replace(cpf, '[^0-9]', '')) AS n
                FROM {bronze_table}
                WHERE cbo LIKE '225%'
                """
            )
            if bronze:
                extras.append({"label": "Databricks · Bronze CNES", "value": bronze})
                break
        except Exception:
            bronze = 0

    silver = 0
    try:
        silver = scalar_int(
            f"""
            SELECT COUNT(DISTINCT regexp_replace(cpf, '[^0-9]', '')) AS n
            FROM {catalog}.silver.tb_cnes_profissionais
            WHERE cbo LIKE '225%'
            """
        )
        if silver:
            extras.append({"label": "Databricks · Silver CNES", "value": silver})
    except Exception:
        silver = 0

    payload = {
        "valor": crm_unicos,
        "crm_unicos": crm_unicos,
        "cpf_unicos": cpf_unicos,
        "total_medicos": total_medicos,
        "total_registros": total_registros,
        "bronze": bronze,
        "silver": silver,
        "fonte": "databricks",
        "tabela": table,
        "metrica": "COUNT(DISTINCT uf_crm) ATIVO",
        "ufs": ufs,
        "genero": genero,
        "tipo_inscricao": tipo,
        "extras": extras,
        "atualizado_cnes": atualizado_cnes,
        "atualizado_cfm": atualizado_cfm or atualizado_gold,
        "atualizado_em": atualizado_gold,
    }
    merge_snapshot("databricks", payload)
    return payload


def count_lines(path: Path) -> int:
    with path.open("rb") as handle:
        return max(sum(1 for _ in handle) - 1, 0)


def pick_field(fields: list[str] | None, *needles: str) -> str | None:
    if not fields:
        return None
    lower = [f.strip().strip('"').lower() for f in fields]
    for needle in needles:
        for original, name in zip(fields, lower):
            if needle in name:
                return original
    return None


def count_cnes_medicos(path: Path) -> int:
    ids: set[str] = set()
    with path.open("r", encoding="latin-1", newline="") as handle:
        reader = csv.DictReader(handle, delimiter=";")
        cbo_key = pick_field(reader.fieldnames, "cbo")
        id_key = pick_field(reader.fieldnames, "profissional") or pick_field(reader.fieldnames, "cpf")
        if not cbo_key or not id_key:
            return count_lines(path)
        for row in reader:
            cbo = (row.get(cbo_key) or "").strip().strip('"')
            if cbo.startswith("225"):
                pid = (row.get(id_key) or "").strip().strip('"')
                if pid:
                    ids.add(pid)
    return len(ids)


def latest_cnes_file(pasta: Path, *needles: str) -> Path | None:
    hits: list[Path] = []
    for path in pasta.rglob("*"):
        if not path.is_file():
            continue
        name = path.name.lower().replace("_", "")
        if path.suffix.lower() not in {".csv", ".txt", ".tsv", ""}:
            continue
        if any(needle in name for needle in needles):
            hits.append(path)
    if not hits:
        return None

    def sort_key(path: Path):
        found = re.search(r"(20\d{4})", path.name)
        return (found.group(1) if found else "", path.stat().st_mtime)

    return sorted(hits, key=sort_key)[-1]


def competencia_from_name(name: str) -> str:
    found = re.search(r"(20\d{2})(\d{2})", name)
    if not found:
        return ""
    return f"{found.group(1)}-{found.group(2)}"


def save_cnes_last(payload: dict) -> None:
    SECRETS.mkdir(parents=True, exist_ok=True)
    CNES_LAST.write_text(json.dumps(payload, ensure_ascii=False, default=str, indent=2), encoding="utf-8")
    merge_snapshot("manual", payload)


def merge_snapshot(fonte: str, payload: dict) -> None:
    data = {}
    if SNAPSHOT.exists():
        try:
            data = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
        except Exception:
            data = {}
    fontes = data.setdefault("fontes", {})
    atual = fontes.setdefault(
        fonte,
        {"gold": 0, "silver": 0, "bronze": 0, "extras": [], "atualizado_em": "", "atualizado_cnes": "", "atualizado_cfm": ""},
    )
    camada = "bronze" if fonte == "manual" else "gold"
    if payload.get("valor") is not None:
        atual[camada] = payload["valor"]
    if payload.get("silver") is not None:
        atual["silver"] = payload["silver"]
    if payload.get("bronze") is not None and fonte != "manual":
        atual["bronze"] = payload["bronze"]
    for key in ("atualizado_em", "atualizado_cnes", "atualizado_cfm", "extras"):
        if payload.get(key) not in (None, "", []):
            atual[key] = payload[key]
    fontes[fonte] = atual
    if payload.get("genero"):
        data["genero"] = payload["genero"]
    if payload.get("tipo_inscricao"):
        data["tipoInscricao"] = payload["tipo_inscricao"]
    if payload.get("ufs") and fonte == "dadosfera":
        data["ufs"] = payload["ufs"]
    SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
    SNAPSHOT.write_text(json.dumps(data, ensure_ascii=False, default=str, indent=2), encoding="utf-8")


def load_cnes_last() -> dict | None:
    if not CNES_LAST.exists():
        return None
    try:
        return json.loads(CNES_LAST.read_text(encoding="utf-8"))
    except Exception:
        return None


def count_cfm_txt_stream(lines) -> tuple[set[str], int]:
    ativos: set[str] = set()
    todos = 0
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        parts = line.split("!")
        if len(parts) < 5:
            continue
        todos += 1
        if parts[4].strip().upper() == "ATIVO":
            ativos.add(f"{parts[1].strip().upper()}|{parts[0].strip()}")
    return ativos, todos


def scan_cfm_zip(zip_path: Path, origem: str = "zip") -> dict:
    ativos: set[str] = set()
    todos = 0
    arquivos = 0
    with zipfile.ZipFile(zip_path) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            stem = Path(info.filename.replace("\\", "/")).stem.upper()
            if stem not in BR_UFS:
                continue
            arquivos += 1
            text = archive.read(info).decode("utf-8-sig", errors="replace")
            chaves, n_todos = count_cfm_txt_stream(text.splitlines())
            ativos.update(chaves)
            todos += n_todos
    if not arquivos:
        raise RuntimeError("O ZIP não tem os TXT por UF (AC.txt, SP.txt, ...).")
    payload = {
        "valor": len(ativos),
        "fonte": "manual",
        "atualizado_em": datetime.fromtimestamp(zip_path.stat().st_mtime).isoformat(timespec="seconds"),
        "arquivo": zip_path.name,
        "origem": origem,
        "extras": [
            {"label": "CRMs únicos ativos (TXT)", "value": len(ativos), "accent": True},
            {"label": "Total registros TXT", "value": todos},
            {"label": "Arquivos UF", "value": arquivos},
        ],
    }
    save_cnes_last(payload)
    return payload


def find_uf_txts(pasta: Path) -> list[Path]:
    return sorted(path for path in pasta.rglob("*.txt") if path.stem.upper() in BR_UFS)


def zip_has_uf_txts(zip_path: Path) -> bool:
    with zipfile.ZipFile(zip_path) as archive:
        nomes = [Path(info.filename.replace("\\", "/")).stem.upper() for info in archive.infolist() if not info.is_dir()]
    return sum(name in BR_UFS for name in nomes) >= 5


def scan_cnes_pasta(pasta: Path, origem: str = "pasta") -> dict:
    if not pasta.exists():
        raise RuntimeError("Pasta CNES não encontrada.")
    uf_txts = find_uf_txts(pasta)
    if uf_txts:
        ativos: set[str] = set()
        todos = 0
        for path in uf_txts:
            text = path.read_text(encoding="utf-8-sig", errors="replace")
            chaves, n_todos = count_cfm_txt_stream(text.splitlines())
            ativos.update(chaves)
            todos += n_todos
        payload = {
            "valor": len(ativos),
            "fonte": "manual",
            "atualizado_em": datetime.fromtimestamp(max(p.stat().st_mtime for p in uf_txts)).isoformat(timespec="seconds"),
            "arquivo": f"{len(uf_txts)} TXT por UF",
            "origem": origem,
            "extras": [
                {"label": "CRMs únicos ativos (TXT)", "value": len(ativos), "accent": True},
                {"label": "Total registros TXT", "value": todos},
            ],
        }
        save_cnes_last(payload)
        return payload

    carga = latest_cnes_file(pasta, "tbcargahorariasus", "cargahoraria")
    prof = latest_cnes_file(pasta, "tbdadosprofissionalsus", "dadosprofissional")
    estab = latest_cnes_file(pasta, "tbestabelecimento")
    if not carga and not prof:
        raise RuntimeError("Não achei os TXT por UF nem tbCargaHorariaSus no ZIP/pasta.")

    medicos = count_cnes_medicos(carga) if carga else 0
    profissionais = count_lines(prof) if prof else 0
    estabelecimentos = count_lines(estab) if estab else 0
    stamp = datetime.fromtimestamp((carga or prof).stat().st_mtime).isoformat(timespec="seconds")
    arquivo = str((carga or prof).name)
    extras = [
        {"label": "Total Médicos CNES (TXT)", "value": medicos or profissionais, "accent": True},
        {"label": "Profissionais CNES", "value": profissionais},
        {"label": "Estabelecimentos CNES", "value": estabelecimentos},
    ]
    payload = {
        "valor": medicos or profissionais,
        "fonte": "manual",
        "atualizado_em": stamp,
        "arquivo": arquivo,
        "competencia": competencia_from_name(arquivo),
        "origem": origem,
        "extras": extras,
    }
    save_cnes_last(payload)
    return payload


def query_cnes(override: dict | None = None) -> dict:
    cfg = merge_cfg(override)
    zip_path = Path((override or {}).get("zip") or cfg.get("txt_zip") or "")
    if zip_path.is_file() and zipfile.is_zipfile(zip_path) and zip_has_uf_txts(zip_path):
        return scan_cfm_zip(zip_path, origem="zip")
    pasta = Path((override or {}).get("pasta") or cfg.get("cnes_pasta") or "")
    return scan_cnes_pasta(pasta, origem="pasta")


def save_multipart_upload(handler: SimpleHTTPRequestHandler) -> tuple[str, Path]:
    ctype = handler.headers.get("Content-Type", "")
    length = int(handler.headers.get("Content-Length") or 0)
    if length <= 0:
        raise RuntimeError("Upload vazio.")
    if length > 3 * 1024 * 1024 * 1024:
        raise RuntimeError("Arquivo maior que 3 GB.")
    match = re.search(r"boundary=([^;]+)", ctype, re.I)
    if not match:
        raise RuntimeError("Upload inválido. Envie um ZIP.")
    boundary = match.group(1).strip().strip('"')
    raw = handler.rfile.read(length)
    parts = raw.split(b"--" + boundary.encode("utf-8"))
    for part in parts:
        if b"filename=" not in part:
            continue
        header, _, body = part.partition(b"\r\n\r\n")
        if body.endswith(b"\r\n"):
            body = body[:-2]
        found = re.search(br'filename="([^"]+)"', header)
        name = found.group(1).decode("utf-8", "replace") if found else "cnes.zip"
        UPLOADS.mkdir(parents=True, exist_ok=True)
        dest = UPLOADS / "cnes_upload.zip"
        dest.write_bytes(body)
        return name, dest
    raise RuntimeError("Não achei o arquivo no upload.")


def unzip_cnes(zip_path: Path) -> Path:
    out = UPLOADS / "cnes_extract"
    if out.exists():
        shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True, exist_ok=True)
    wanted = ("tbcargahoraria", "tbdadosprofissional", "tbestabelecimento")
    extracted = 0
    with zipfile.ZipFile(zip_path) as archive:
        selected = []
        for info in archive.infolist():
            if info.is_dir():
                continue
            base = Path(info.filename.replace("\\", "/")).name.lower().replace("_", "")
            if any(token in base for token in wanted):
                selected.append(info)
        if not selected:
            selected = [
                info
                for info in archive.infolist()
                if not info.is_dir() and Path(info.filename).suffix.lower() in {".csv", ".txt", ".tsv"}
            ]
        for info in selected:
            rel = Path(info.filename.replace("\\", "/"))
            if ".." in rel.parts:
                continue
            target = out / rel.name
            with archive.open(info) as src, target.open("wb") as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
            extracted += 1
            try:
                stamp = datetime(*info.date_time).timestamp()
                os.utime(target, (stamp, stamp))
            except Exception:
                pass
    if not extracted:
        raise RuntimeError("O ZIP não tinha CSV/TXT do CNES.")
    return out


def query_cnes_zip(handler: SimpleHTTPRequestHandler) -> dict:
    name, zip_path = save_multipart_upload(handler)
    if not zipfile.is_zipfile(zip_path):
        raise RuntimeError("Envie a pasta compactada em .zip.")
    if zip_has_uf_txts(zip_path):
        payload = scan_cfm_zip(zip_path, origem="zip")
        payload["arquivo"] = name
        save_cnes_last(payload)
        return payload
    pasta = unzip_cnes(zip_path)
    payload = scan_cnes_pasta(pasta, origem="zip")
    payload["arquivo"] = f"{name} · {payload.get('arquivo')}"
    save_cnes_last(payload)
    return payload


def status_payload() -> dict:
    cfg = load_cfg()
    pasta = Path(cfg.get("cnes_pasta") or "")
    last = load_cnes_last()
    return {
        "snowflake": {
            "ok": bool(cfg.get("snowflake_account") and (SECRETS / "snowflake_rsa_key.p8").exists()),
            "account": cfg.get("snowflake_account"),
            "user": cfg.get("snowflake_user"),
            "warehouse": cfg.get("snowflake_warehouse"),
        },
        "databricks": {
            "ok": bool(cfg.get("databricks_host") and cfg.get("databricks_token")),
            "host": cfg.get("databricks_host"),
            "warehouse_id": cfg.get("databricks_warehouse_id"),
            "tabela": f"{cfg.get('databricks_catalog', 'dev')}.gold.{cfg.get('databricks_table', 'tb_medicos')}",
        },
        "cnes": {
            "ok": pasta.exists() or bool(last),
            "pasta": str(pasta) if pasta.exists() else "",
            "last": last,
        },
    }


class Handler(SimpleHTTPRequestHandler):
    timeout = 900

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        print("[painel]", fmt % args, flush=True)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/status":
            send_json(self, status_payload())
            return
        super().do_GET()

    def do_POST(self) -> None:
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/api/cnes-zip":
                send_json(self, query_cnes_zip(self))
                return
            body = read_json(self)
            if parsed.path == "/api/snowflake":
                send_json(self, query_snowflake(body))
                return
            if parsed.path == "/api/dadosfera-bi":
                send_json(self, query_dadosfera_bi(body))
                return
            if parsed.path == "/api/medicos-novos":
                send_json(self, query_medicos_novos(body))
                return
            if parsed.path == "/api/cidades-novos":
                send_json(self, query_cidades_novos(body))
                return
            if parsed.path == "/api/cnes-busca":
                send_json(self, query_cnes_busca(body))
                return
            if parsed.path == "/api/databricks":
                send_json(self, query_databricks(body))
                return
            if parsed.path == "/api/cnes":
                send_json(self, query_cnes(body))
                return
            send_json(self, {"error": "Rota não encontrada."}, 404)
        except Exception as exc:
            send_json(self, {"error": str(exc)}, 400)


def main() -> None:
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Painel em http://{HOST}:{PORT}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
