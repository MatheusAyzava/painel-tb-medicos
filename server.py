#!/usr/bin/env python3
"""Painel TB Médicos. Rode: python server.py"""

from __future__ import annotations

import csv
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

        atualizado_gold = scalar_date("SELECT MAX(UPDATE_DATE) AS ULTIMA_ATUALIZACAO FROM GOLD.TB_MEDICOS")
        atualizado_cfm = scalar_date("SELECT MAX(UPDATE_DATE) AS ULTIMA_ATUALIZACAO_CFM FROM SILVER.TB_CFM")
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
