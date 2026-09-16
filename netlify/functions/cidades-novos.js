const { json, queryCidadesNovos } = require("../lib/backend");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    return json(200, await queryCidadesNovos(body));
  } catch (err) {
    return json(400, { error: err.message });
  }
};
