const { app } = require("@azure/functions");
const { TableClient } = require("@azure/data-tables");

app.http("orders", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "orders",
  handler: async (request, context) => {
    try {
      const body = await request.json();

      if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
        return {
          status: 400,
          jsonBody: {
            message: "O pedido precisa conter ao menos um item."
          }
        };
      }

      const invalidItem = body.items.find(
        item => !item.title || !item.quantity || Number(item.quantity) <= 0
      );

      if (invalidItem) {
        return {
          status: 400,
          jsonBody: {
            message: "Existe item inválido no pedido."
          }
        };
      }

      const connectionString = process.env.STORAGE_CONNECTION_STRING;
      const tableName = process.env.ORDERS_TABLE_NAME || "Orders";

      if (!connectionString) {
        context.error("STORAGE_CONNECTION_STRING não configurada.");

        return {
          status: 500,
          jsonBody: {
            message: "Configuração da Storage Account não encontrada."
          }
        };
      }

      const client = TableClient.fromConnectionString(connectionString, tableName);

      const now = new Date();
      const orderId = `ORD-${now
        .toISOString()
        .replace(/[-:.TZ]/g, "")
        .slice(0, 14)}`;

      const totalItems = body.items.reduce(
        (acc, item) => acc + Number(item.quantity || 0),
        0
      );

      const entity = {
        partitionKey: "anonymous",
        rowKey: orderId,
        orderId,
        createdAt: now.toISOString(),
        status: "CREATED",
        customerName: body.customerName || "",
        customerEmail: body.customerEmail || "",
        itemsJson: JSON.stringify(body.items),
        totalItems
      };

      await client.createEntity(entity);

      return {
        status: 201,
        jsonBody: {
          message: "Pedido criado com sucesso.",
          orderId
        }
      };
    } catch (error) {
      context.error(error);

      return {
        status: 500,
        jsonBody: {
          message: "Erro ao criar pedido."
        }
      };
    }
  }
});