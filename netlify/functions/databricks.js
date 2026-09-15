const { json, queryDatabricks } = require("../lib/backend");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  try {
    return json(200, await queryDatabricks());
  } catch (err) {
    return json(400, { error: err.message });
  }
};
