const { json, queryCnesBusca } = require("../lib/backend");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    return json(200, await queryCnesBusca(body));
  } catch (err) {
    const raw = String(err && err.message || "");
    const error = /timeout|timed out|cancelled|canceled|408|504|333334|warehouse timeout|statement timeout|passou do tempo/i.test(raw)
      ? "A busca passou do tempo. Use nome e sobrenome, CRM completo ou filtre um estado."
      : (raw || "Falha na busca CNES");
    return json(400, { error });
  }
};
