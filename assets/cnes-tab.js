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

function cnesPessoaId(d) {
  return d && (d.pessoa_id || `${d.uf_crm || ""}::${String(d.nome || "").trim().toUpperCase()}`);
}

function vinculosDoMedico(pessoaId) {
  return ((cnesState.data && cnesState.data.vinculos) || []).filter((v) => cnesPessoaId(v) === pessoaId);
}

function cnesHorasPorCbo(rows) {
  const byCbo = new Map();
  (rows || []).forEach((v) => {
    const label = String(v.cbo || "Sem CBO").trim() || "Sem CBO";
    if (!byCbo.has(label)) {
      byCbo.set(label, { cbo: label, horas: 0, estabelecimento: v.estabelecimento || "", _max: -1 });
    }
    const item = byCbo.get(label);
    const horas = Number(v.horas_total) || 0;
    item.horas += horas;
    if (horas >= item._max) {
      item._max = horas;
      item.estabelecimento = v.estabelecimento || item.estabelecimento;
    }
  });
  return [...byCbo.values()]
    .map(({ _max, ...rest }) => rest)
    .sort((a, b) => b.horas - a.horas || a.cbo.localeCompare(b.cbo, "pt-BR"));
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
      <span>${cnesEsc(d.uf_crm || "sem CRM")} · ${cnesFmt(d.vinculos)} vínculo(s) · ${cnesFmt(d.horas_total)}h · ${cnesEsc(d.setor || "—")}</span>
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
  const cbos = document.getElementById("cnes-cbos");
  document.querySelectorAll(".cnes-doc").forEach((btn) => btn.classList.toggle("on", btn.dataset.pessoa === pessoaId));
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
  const horasCbo = cnesHorasPorCbo(rows);
  const horasTotal = rows.reduce((s, v) => s + (Number(v.horas_total) || 0), 0);
  const ests = new Set(rows.map((v) => v.estabelecimento).filter(Boolean));
  const principalEst = doc.estabelecimento
    || (horasCbo[0] && horasCbo[0].estabelecimento)
    || "";
  title.textContent = doc.nome || doc.uf_crm;
  local.textContent = `${doc.uf_crm || "sem CRM"} · CNS ${doc.cns || "—"} · ${((doc.cidades) || []).join(" · ") || "sem cidade"}`;
  kpis.innerHTML = `
    <div><b>${cnesFmt(horasTotal)}h</b><span>Total geral</span></div>
    <div><b>${cnesFmt(horasCbo.length)}</b><span>CBOs</span></div>
    <div><b>${cnesFmt(ests.size || doc.vinculos)}</b><span>Estabelecimentos</span></div>
  `;
  if (cbos) {
    cbos.hidden = !horasCbo.length;
    cbos.innerHTML = horasCbo.map((item) => `
      <div>
        <b>${cnesFmt(item.horas)}h</b>
        <strong title="${cnesEsc(item.cbo || "")}">${cnesCbo(item.cbo)}</strong>
        <span title="${cnesEsc(item.estabelecimento || "")}">${cnesEsc(item.estabelecimento || "—")}</span>
      </div>
    `).join("");
  }
  if (principal) {
    principal.hidden = !principalEst;
    principal.innerHTML = principalEst
      ? `<span>Onde mais atende</span><strong title="${cnesEsc(principalEst)}">${cnesEsc(principalEst)}</strong>`
      : "";
  }
  if (!rows.length) {
    body.innerHTML = "<tr><td colspan='7'>Sem vínculos CNES para este profissional.</td></tr>";
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
      <td class="hrs">${cnesFmt(horasTotal)}</td>
    </tr>`;
}

async function buscarCnes() {
  const q = document.getElementById("cnes-q").value.trim();
  const uf = document.getElementById("cnes-uf").value;
  const mesEl = document.getElementById("cnes-mes");
  const mes = mesEl ? mesEl.value : "";
  const novos = Boolean(mes);
  const count = document.getElementById("cnes-count");
  count.textContent = "Consultando CNES no Snowflake…";
  try {
    const res = await fetch("/api/cnes-busca", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q, uf, novos, mes: mes || cnesMesAtual() }),
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (err) {
      throw new Error("A consulta passou do tempo no servidor. Tente de novo em alguns segundos.");
    }
    if (!res.ok) {
      const raw = String(data.error || "");
      throw new Error(/timeout|timed out|cancelled|canceled|408|504|warehouse timeout|statement timeout|passou do tempo/i.test(raw)
        ? "A busca passou do tempo. Use nome e sobrenome, CRM completo ou filtre um estado."
        : (raw || "Falha na busca CNES"));
    }
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
  const header = ["CNS", "NOME", "UF", "MUNICIPIO", "CBO", "ESTABELECIMENTO", "HORAS"].join(";");
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
