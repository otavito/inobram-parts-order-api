const { app } = require("@azure/functions");
const { EmailClient } = require("@azure/communication-email");

function validatePayload(body) {
  if (!body.customerName) {
    throw new Error("O campo 'customerName' é obrigatório.");
  }

  if (!body.customerEmail) {
    throw new Error("O campo 'customerEmail' é obrigatório.");
  }

  if (!Array.isArray(body.items)) {
    throw new Error("O campo 'items' deve ser um array.");
  }

  if (body.items.length === 0) {
    throw new Error("O campo 'items' deve conter ao menos um item.");
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getItemTitle(item) {
  return item.title || item.item || item.name || "";
}

function getItemQuantity(item) {
  return item.quantity || item.qty || 0;
}

function buildItemsTable(items) {
  return `
    <table style="border-collapse: collapse; width: 100%; font-family: Arial, sans-serif; font-size: 14px;">
      <thead>
        <tr>
          <th style="border: 1px solid #d9d9d9; padding: 10px; text-align: left; background-color: #f0f0f0;">
            Item
          </th>
          <th style="border: 1px solid #d9d9d9; padding: 10px; text-align: center; width: 100px; background-color: #f0f0f0;">
            Quantidade
          </th>
        </tr>
      </thead>
      <tbody>
        ${items.map((item) => `
          <tr>
            <td style="border: 1px solid #d9d9d9; padding: 10px;">
              ${escapeHtml(getItemTitle(item))}
            </td>
            <td style="border: 1px solid #d9d9d9; padding: 10px; text-align: center;">
              ${escapeHtml(getItemQuantity(item))}
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function buildEmailHtml(body) {
  return `
    <html>
      <body style="margin: 0; padding: 24px; font-family: Arial, sans-serif; color: #333;">
        <div style="max-width: 700px; margin: 0 auto;">
          <h1 style="font-size: 22px; margin-bottom: 20px;">
            Pedido de Peças Recebido
          </h1>

          <p style="font-size: 15px; margin-bottom: 20px;">
            Olá <strong>${escapeHtml(body.customerName)}</strong>,
          </p>

          <p style="font-size: 15px; margin-bottom: 24px;">
            Recebemos seu pedido de peças. Abaixo estão os itens solicitados:
          </p>

          ${buildItemsTable(body.items)}

          <p style="font-size: 14px; margin-top: 24px;">
            Obrigado.
          </p>
        </div>
      </body>
    </html>
  `;
}

function buildPlainText(body) {
  const itemsText = body.items
    .map((item) => `- ${getItemTitle(item)} | Quantidade: ${getItemQuantity(item)}`)
    .join("\n");

  return `
Confirmação de Pedido

Olá ${body.customerName},

Recebemos seu pedido de peças.

Itens:
${itemsText}

Obrigado.
  `.trim();
}

app.http("sendEmail", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "send-email",
  handler: async (request, context) => {
    try {
      const body = await request.json();

      context.log("Payload de envio de e-mail recebido.");

      validatePayload(body);

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
          subject: "Pedido Recebido",
          html: buildEmailHtml(body),
          plainText: buildPlainText(body)
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
          message: "E-mail de confirmação enviado.",
          status: result.status || null,
          operationId: result.id || null
        }
      };
    } catch (error) {
      context.error("ERRO no envio de e-mail:", error);

      return {
        status: 500,
        jsonBody: {
          message: "Falha ao enviar e-mail de confirmação.",
          error: error.message
        }
      };
    }
  }
});