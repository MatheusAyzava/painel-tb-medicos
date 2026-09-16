const cnesState = { data: null, selecionado: null };

function cnesEsc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function cnesCurto(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "—") return "—";
  const first = raw.split("/")[0].replace(/^\s*[\d.\s-]+/, "").replace(/^\d+\s*-\s*/, "").trim();
  const text = (first || raw).replace(/\s+/g, " ").trim();
  const clean = text.replace(/\bnao se aplica\b/ig, "").replace(/\s{2,}/g, " ").trim() || raw;
  const lower = clean.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function cnesCbo(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "—") return "—";
  const match = raw.match(/^(\d+)\s*-\s*(.+)$/);
  if (!match) return cnesEsc(raw);
  return `<em>${cnesEsc(match[1])}</em> ${cnesEsc(match[2])}`;
}

function cnesFmt(n) {
  return Math.round(Number(n) || 0).toLocaleString("pt-BR");
}

function cnesMesAtual() {
  if (typeof mesValue === "function") return mesValue();
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function cnesMesLabel() {
  if (typeof mesLabel === "function") return mesLabel(cnesMesAtual()) || "mês";
  return cnesMesAtual();
}

function atualizarCnesMes() {
  const el = document.getElementById("cnes-mes");
  if (el) el.textContent = cnesMesLabel();
}

function cnesPessoaId(d) {
  return d && (d.pessoa_id || `${d.uf_crm || ""}::${String(d.nome || "").trim().toUpperCase()}`);
}

function vinculosDoMedico(pessoaId) {
  return ((cnesState.data && cnesState.data.vinculos) || []).filter((v) => cnesPessoaId(v) === pessoaId);
}

function renderCnesDocs() {
  const box = document.getElementById("cnes-docs");
  const count = document.getElementById("cnes-count");
  const docs = (cnesState.data && cnesState.data.profissionais) || [];
  count.textContent = docs.length
    ? `${cnesFmt(docs.length)} médico(s) — clique para ver os estabelecimentos`
    : (cnesState.data && cnesState.data.aviso) || "Nenhum médico encontrado.";
  box.innerHTML = docs.map((d) => `
    <button type="button" class="cnes-doc${cnesState.selecionado === cnesPessoaId(d) ? " on" : ""}" data-pessoa="${cnesEsc(cnesPessoaId(d))}">
      <strong>${cnesEsc(d.nome || d.uf_crm)}</strong>
      <span>${cnesEsc(d.uf_crm)} · ${cnesFmt(d.vinculos)} vínculo(s) · ${cnesFmt(d.horas_total)}h · ${cnesEsc(d.setor || "—")}</span>
    </button>
  `).join("");
}

function renderCnesDetalhe(pessoaId) {
  cnesState.selecionado = pessoaId;
  const docs = (cnesState.data && cnesState.data.profissionais) || [];
  const doc = docs.find((d) => cnesPessoaId(d) === pessoaId);
  const rows = vinculosDoMedico(pessoaId);
  const title = document.getElementById("cnes-detail-title");
  const local = document.getElementById("cnes-detail-local");
  const kpis = document.getElementById("cnes-kpis");
  const body = document.getElementById("cnes-vinculos");
  const principal = document.getElementById("cnes-principal");
  document.querySelectorAll(".cnes-doc").forEach((btn) => btn.classList.toggle("on", btn.dataset.pessoa === pessoaId));
  const cbos = document.getElementById("cnes-cbos");
  if (!doc) {
    title.textContent = "Detalhe do profissional";
    local.textContent = "Selecione um médico à esquerda.";
    kpis.innerHTML = "";
    if (cbos) {
      cbos.hidden = true;
      cbos.innerHTML = "";
    }
    if (principal) {
      principal.hidden = true;
      principal.innerHTML = "";
    }
    body.innerHTML = "<tr><td colspan='7'>Nenhum vínculo carregado.</td></tr>";
    return;
  }
  title.textContent = doc.nome || doc.uf_crm;
  local.textContent = `${doc.uf_crm} · CNS ${doc.cns || "—"} · ${((doc.cidades) || []).join(" · ") || "sem cidade"}`;
  kpis.innerHTML = `
    <div><b>${cnesFmt(doc.horas_total)}h</b><span>Total geral</span></div>
    <div><b>${cnesFmt((doc.horas_cbo || []).length)}</b><span>CBOs</span></div>
    <div><b>${cnesFmt(doc.vinculos)}</b><span>Estabelecimentos</span></div>
  `;
  if (cbos) {
    const lista = doc.horas_cbo || [];
    cbos.hidden = !lista.length;
    cbos.innerHTML = lista.map((item) => `
      <div>
        <b>${cnesFmt(item.horas)}h</b>
        <strong title="${cnesEsc(item.cbo || "")}">${cnesCbo(item.cbo)}</strong>
        <span title="${cnesEsc(item.estabelecimento || "")}">${cnesEsc(item.estabelecimento || "—")}</span>
      </div>
    `).join("");
  }
  if (principal) {
    principal.hidden = !doc.estabelecimento;
    principal.innerHTML = doc.estabelecimento
      ? `<span>Onde mais atende</span><strong title="${cnesEsc(doc.estabelecimento)}">${cnesEsc(doc.estabelecimento)}</strong>`
      : "";
  }
  if (!rows.length) {
    body.innerHTML = "<tr><td colspan='7'>Sem vínculos CNES para este CRM.</td></tr>";
    return;
  }
  const ordered = [...rows].sort((a, b) => String(a.cbo || "").localeCompare(String(b.cbo || ""), "pt-BR") || (Number(b.horas_total) || 0) - (Number(a.horas_total) || 0));
  body.innerHTML = ordered.map((v) => `
    <tr>
      <td>${cnesEsc(v.cns || "—")}</td>
      <td>${cnesEsc(v.nome || "—")}</td>
      <td class="uf">${cnesEsc(v.uf || "—")}</td>
      <td>${cnesEsc(v.municipio || "—")}</td>
      <td class="cbo" title="${cnesEsc(v.cbo || "")}">${cnesCbo(v.cbo)}</td>
      <td class="est" title="${cnesEsc(v.estabelecimento || "")}">${cnesEsc(v.estabelecimento || "—")}</td>
      <td class="hrs">${cnesFmt(v.horas_total)}</td>
    </tr>`).join("") + `
    <tr class="cnes-total">
      <td colspan="6">Total geral</td>
      <td class="hrs">${cnesFmt(doc.horas_total)}</td>
    </tr>`;
}

async function buscarCnes() {
  atualizarCnesMes();
  const q = document.getElementById("cnes-q").value.trim();
  const uf = document.getElementById("cnes-uf").value;
  const novos = document.getElementById("cnes-novos").checked;
  const count = document.getElementById("cnes-count");
  count.textContent = "Consultando CNES no Snowflake…";
  try {
    const res = await fetch("/api/cnes-busca", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q, uf, novos, mes: cnesMesAtual() }),
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (err) {
      throw new Error("A consulta passou do tempo no servidor. Tente de novo em alguns segundos.");
    }
    if (!res.ok) throw new Error(data.error || "Falha na busca CNES");
    cnesState.data = data;
    cnesState.selecionado = null;
    renderCnesDocs();
    const first = (data.profissionais || [])[0];
    if (first) renderCnesDetalhe(cnesPessoaId(first));
    else renderCnesDetalhe(null);
  } catch (err) {
    count.textContent = err.message || "Não consultei o CNES.";
  }
}

function baixarCnesCsv() {
  const rows = cnesState.selecionado
    ? vinculosDoMedico(cnesState.selecionado)
    : ((cnesState.data && cnesState.data.vinculos) || []);
  if (!rows.length) return;
  const header = [
    "CNS", "NOME", "UF", "MUNICIPIO", "CBO", "ESTABELECIMENTO", "HORAS",
  ].join(";");
  const esc = (v) => {
    const t = String(v == null ? "" : v);
    if (/[;"\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
    return t;
  };
  const body = rows.map((v) => [
    v.cns, v.nome, v.uf, v.municipio, v.cbo, v.estabelecimento, v.horas_total,
  ].map(esc).join(";")).join("\n");
  const blob = new Blob(["\ufeff" + header + "\n" + body], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `cnes-${cnesState.selecionado || "busca"}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function initCnesTab() {
  const btn = document.getElementById("cnes-btn");
  const csv = document.getElementById("cnes-csv");
  const q = document.getElementById("cnes-q");
  const docs = document.getElementById("cnes-docs");
  if (!btn || !q) return;
  atualizarCnesMes();
  btn.addEventListener("click", buscarCnes);
  if (csv) csv.addEventListener("click", baixarCnesCsv);
  q.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      buscarCnes();
    }
  });
  if (docs) {
    docs.addEventListener("click", (event) => {
      const card = event.target.closest(".cnes-doc");
      if (card && card.dataset.pessoa) renderCnesDetalhe(card.dataset.pessoa);
    });
  }
}

initCnesTab();
