const cnesState = { data: null, selecionado: null };

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

function vinculosDoMedico(ufCrm) {
  return ((cnesState.data && cnesState.data.vinculos) || []).filter((v) => v.uf_crm === ufCrm);
}

function renderCnesDocs() {
  const box = document.getElementById("cnes-docs");
  const count = document.getElementById("cnes-count");
  const docs = (cnesState.data && cnesState.data.profissionais) || [];
  count.textContent = docs.length
    ? `${cnesFmt(docs.length)} médico(s) — clique para ver os estabelecimentos`
    : (cnesState.data && cnesState.data.aviso) || "Nenhum médico encontrado.";
  box.innerHTML = docs.map((d) => `
    <button type="button" class="cnes-doc${cnesState.selecionado === d.uf_crm ? " on" : ""}" data-ufcrm="${d.uf_crm}">
      <strong>${d.nome || d.uf_crm}</strong>
      <span>${d.uf_crm} · ${cnesFmt(d.vinculos)} vínculo(s) · ${cnesFmt(d.horas_total)}h · ${d.setor || "—"}</span>
    </button>
  `).join("");
}

function renderCnesDetalhe(ufCrm) {
  cnesState.selecionado = ufCrm;
  const docs = (cnesState.data && cnesState.data.profissionais) || [];
  const doc = docs.find((d) => d.uf_crm === ufCrm);
  const rows = vinculosDoMedico(ufCrm);
  const title = document.getElementById("cnes-detail-title");
  const local = document.getElementById("cnes-detail-local");
  const kpis = document.getElementById("cnes-kpis");
  const body = document.getElementById("cnes-vinculos");
  document.querySelectorAll(".cnes-doc").forEach((btn) => btn.classList.toggle("on", btn.dataset.ufcrm === ufCrm));
  if (!doc) {
    title.textContent = "Detalhe do profissional";
    local.textContent = "Selecione um médico à esquerda.";
    kpis.innerHTML = "";
    body.innerHTML = "<tr><td colspan='11'>Nenhum vínculo carregado.</td></tr>";
    return;
  }
  title.textContent = doc.nome || doc.uf_crm;
  local.textContent = `${doc.uf_crm} · CNS ${doc.cns || "—"} · CPF ${doc.cpf || "—"} · ${((doc.cidades) || []).join(" · ") || "sem cidade"}`;
  kpis.innerHTML = `
    <div><b>${cnesFmt(doc.horas_total)}h</b><span>Carga horária total</span></div>
    <div><b>${cnesFmt(doc.vinculos)}</b><span>Estabelecimentos</span></div>
    <div><b>${doc.setor || "—"}</b><span>Setor do principal</span></div>
    <div><b>${doc.estabelecimento || "—"}</b><span>Onde mais atende</span></div>
  `;
  if (!rows.length) {
    body.innerHTML = "<tr><td colspan='11'>Sem vínculos CNES para este CRM.</td></tr>";
    return;
  }
  body.innerHTML = rows.map((v) => `
    <tr>
      <td>${v.cnes || "—"}</td>
      <td>${v.estabelecimento || "—"}</td>
      <td>${v.municipio || "—"}</td>
      <td>${v.uf || "—"}</td>
      <td>${v.setor || "—"}</td>
      <td>${cnesFmt(v.horas_total)}</td>
      <td>${cnesFmt(v.horas_amb)}</td>
      <td>${cnesFmt(v.horas_hosp)}</td>
      <td>${v.cbo || "—"}</td>
      <td>${v.vinculo || "—"}</td>
      <td>${[v.endereco, v.bairro, v.cep].filter(Boolean).join(" · ") || "—"}</td>
    </tr>
  `).join("");
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
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Falha na busca CNES");
    cnesState.data = data;
    cnesState.selecionado = null;
    renderCnesDocs();
    const first = (data.profissionais || [])[0];
    if (first) renderCnesDetalhe(first.uf_crm);
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
    "UF_CRM", "NOME", "CPF", "CNS", "CRM", "CBO", "CNES", "ESTABELECIMENTO", "CNPJ",
    "SETOR", "NATUREZA", "GESTAO", "SUS", "VINCULO", "HORAS_TOTAL", "HORAS_AMB", "HORAS_HOSP",
    "MUNICIPIO", "UF", "IBGE", "ENDERECO", "BAIRRO", "CEP", "TELEFONE", "TIPO", "UNIDADE",
  ].join(";");
  const esc = (v) => {
    const t = String(v == null ? "" : v);
    if (/[;"\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
    return t;
  };
  const body = rows.map((v) => [
    v.uf_crm, v.nome, v.cpf, v.cns, v.crm, v.cbo, v.cnes, v.estabelecimento, v.cnpj,
    v.setor, v.natureza, v.gestao, v.sus, v.vinculo, v.horas_total, v.horas_amb, v.horas_hosp,
    v.municipio, v.uf, v.ibge, v.endereco, v.bairro, v.cep, v.telefone, v.tipo, v.unidade,
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
      if (card && card.dataset.ufcrm) renderCnesDetalhe(card.dataset.ufcrm);
    });
  }
}

initCnesTab();
