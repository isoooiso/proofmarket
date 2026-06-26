export default {
  fetch() {
    return Response.json({
      ok: true,
      service: "proofmarket-api",
    });
  },
};
