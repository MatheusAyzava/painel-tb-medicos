const { json, queryDadosferaBi } = require("../lib/backend");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  try {
    const snap = require("../../assets/snapshot-bi.json");
    return json(200, snap);
  } catch (err) {
    try {
      return json(200, await queryDadosferaBi());
    } catch (liveErr) {
      return json(400, { error: liveErr.message || err.message });
    }
  }
};
