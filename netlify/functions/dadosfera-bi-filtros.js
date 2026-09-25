const { json, queryDadosferaBiFiltros } = require("../lib/backend");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  try {
    return json(200, await queryDadosferaBiFiltros());
  } catch (err) {
    return json(400, { error: err.message || "Falha ao filtrar a Visão por UF." });
  }
};
