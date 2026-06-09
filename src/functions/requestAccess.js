const { app } = require("@azure/functions");
const { EmailClient } = require("@azure/communication-email");
const {
  getGoogleIdentityFromSwa,
  getMicrosoftIdentityFromBearerToken
} = require("../shared/auth");

function validatePayload(body) {
  if (!body.name) {
    throw new Error("O campo 'name' é obrigatório.");
  }

  if (!body.email) {
    throw new Error("O campo 'email' é obrigatório.");
  }
}

function buildPlainText(body) {
  return `
Olá!

O usuário ${body.name} esta solicitando acesso a aplicação de reposição de peças.
Email do usuário: ${body.email}

Verificar pedido de acesso.
  `.trim();
}

app.http("RequestAccess", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "request-access",
  handler: async (request, context) => {
    try {
      const identityFromSwa = await getGoogleIdentityFromSwa(request);
      const identityFromMicrosoft = identityFromSwa
        ? null
        : await getMicrosoftIdentityFromBearerToken(request);
      const identity = identityFromSwa || identityFromMicrosoft;

      let body = {};
      try {
        body = await request.json();
      } catch {
        body = {};
      }

      const requestData = {
        name: identity?.name || body.name || "",
        email: identity?.email || body.email || ""
      };

      context.log("Payload de solicitação de acesso recebido.");

      validatePayload(requestData);

      const connectionString = process.env.COMMUNICATION_SERVICES_CONNECTION_STRING;
      const senderAddress = process.env.EMAIL_SENDER_ADDRESS;

      if (!connectionString) {
        throw new Error("COMMUNICATION_SERVICES_CONNECTION_STRING não está configurada.");
      }

      if (!senderAddress) {
        throw new Error("EMAIL_SENDER_ADDRESS não está configurado.");
      }

      const emailClient = new EmailClient(connectionString);

      const emailMessage = {
        senderAddress,
        content: {
          subject: "Pedido de Acesso - Spare Parts App",
          plainText: buildPlainText(requestData)
        },
        recipients: {
          to: [
            {
              address: "otavio.ladoruski@speria.inobram.com.br"
            },
            {
              address: "vanessa.moraes@speria.inobram.com.br"
            },
            {
              address: "leandro.pereira@speria.inobram.com.br"
            }
          ]
        }
      };

      const poller = await emailClient.beginSend(emailMessage);
      const result = await poller.pollUntilDone();

      return {
        status: 202,
        jsonBody: {
          message: "Pedido de acesso enviado por e-mail.",
          status: result.status || null,
          operationId: result.id || null
        }
      };
    } catch (error) {
      context.error("ERRO no envio de pedido de acesso:", error);

      return {
        status: 500,
        jsonBody: {
          message: "Falha ao enviar pedido de acesso por e-mail.",
          error: error.message
        }
      };
    }
  }
});
