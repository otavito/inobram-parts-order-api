const { app } = require("@azure/functions");
const { requireAuthorizedUser } = require("../shared/auth");

app.http("me", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "me",
  handler: async (request, context) => {
    try {
      const user = await requireAuthorizedUser(request);

      return {
        status: 200,
        jsonBody: user
      };
    } catch (error) {
      context.error("ERRO ao consultar /api/me:", error);

      return {
        status: 500,
        jsonBody: {
          message: "Erro ao consultar usuário autenticado.",
          error: error.message
        }
      };
    }
  }
});
