const { app } = require("@azure/functions");
const { TableClient } = require("@azure/data-tables");
const { requireAuthorizedUser, listAuthorizedUsers } = require("../shared/auth");

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function escapeODataString(value) {
  return String(value || "").replace(/'/g, "''");
}

function getQueryValue(request, key) {
  if (request.query && typeof request.query.get === "function") {
    return String(request.query.get(key) || "").trim();
  }

  const url = new URL(request.url);
  return String(url.searchParams.get(key) || "").trim();
}

function parseDateFilter(value, label) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Filtro inválido: ${label}. Use formato ISO, por exemplo 2026-06-01.`);
  }

  return date;
}

function applyOrderFilters(orders, filters) {
  const {
    status,
    dateFrom,
    dateTo,
    search
  } = filters;

  return orders.filter(order => {
    const orderStatus = normalize(order.status);
    const orderDate = order.createdAt ? new Date(order.createdAt) : null;
    const searchText = normalize([
      order.orderId,
      order.rowKey,
      order.customerName,
      order.customerEmail,
      order.partitionKey,
      order.status,
      order.itemsJson
    ].join(" "));

    if (status && orderStatus !== normalize(status)) {
      return false;
    }

    if (dateFrom && (!orderDate || Number.isNaN(orderDate.getTime()) || orderDate < dateFrom)) {
      return false;
    }

    if (dateTo && (!orderDate || Number.isNaN(orderDate.getTime()) || orderDate > dateTo)) {
      return false;
    }

    if (search && !searchText.includes(normalize(search))) {
      return false;
    }

    return true;
  });
}

function sortOrdersByCreatedAtDesc(orders) {
  return [...orders].sort((a, b) => {
    const left = Date.parse(a?.createdAt || "");
    const right = Date.parse(b?.createdAt || "");

    if (Number.isNaN(left) && Number.isNaN(right)) {
      return 0;
    }

    if (Number.isNaN(left)) {
      return 1;
    }

    if (Number.isNaN(right)) {
      return -1;
    }

    return right - left;
  });
}

async function listOrders(request, user, client) {
  const role = normalize(user.role);
  const isAdminOrStaff = role === "admin" || role === "staff";
  const isPartner = role === "partner";

  if (!isAdminOrStaff && !isPartner) {
    return {
      status: 403,
      jsonBody: {
        message: "Perfil sem permissão para consultar pedidos."
      }
    };
  }

  const statusFilter = getQueryValue(request, "status");
  const emailFilter = getQueryValue(request, "email");
  const dateFromFilter = parseDateFilter(getQueryValue(request, "dateFrom"), "dateFrom");
  const dateToFilter = parseDateFilter(getQueryValue(request, "dateTo"), "dateTo");
  const searchFilter = getQueryValue(request, "search");

  const effectiveEmail = isPartner ? normalize(user.email) : normalize(emailFilter);
  const queryOptions = effectiveEmail
    ? { filter: `PartitionKey eq '${escapeODataString(effectiveEmail)}'` }
    : undefined;

  const entities = [];
  for await (const entity of client.listEntities({ queryOptions })) {
    entities.push(entity);
  }

  const filteredOrders = applyOrderFilters(entities, {
    status: statusFilter,
    dateFrom: dateFromFilter,
    dateTo: dateToFilter,
    search: searchFilter
  });

  const sortedOrders = sortOrdersByCreatedAtDesc(filteredOrders);

  let users = [];
  if (isAdminOrStaff) {
    const authorizedUsers = await listAuthorizedUsers();
    users = authorizedUsers
      .filter(user => user.isActive)
      .map(user => ({
        email: user.email,
        name: user.name,
        role: user.role
      }))
      .sort((a, b) => normalize(a.name).localeCompare(normalize(b.name)));
  }

  return {
    status: 200,
    jsonBody: {
      items: sortedOrders,
      total: sortedOrders.length,
      viewerRole: role,
      users,
      filters: {
        status: statusFilter || "",
        email: effectiveEmail || "",
        dateFrom: getQueryValue(request, "dateFrom") || "",
        dateTo: getQueryValue(request, "dateTo") || "",
        search: searchFilter || ""
      }
    }
  };
}

async function createOrder(request, user, client) {
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

  const customerEmail = user.email;
  const customerName = body.customerName || user.name || "";

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
    partitionKey: customerEmail,
    rowKey: orderId,
    createdAt: now.toISOString(),
    status: "CREATED",
    customerName,
    customerProvider: user.provider,
    customerRole: user.role,
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
}

app.http("orders", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  route: "orders",
  handler: async (request, context) => {
    try {
      const user = await requireAuthorizedUser(request);

      if (!user.authenticated) {
        return {
          status: 401,
          jsonBody: {
            message: "Usuário não autenticado."
          }
        };
      }

      if (!user.authorized) {
        return {
          status: 403,
          jsonBody: {
            message: "Usuário sem permissão para acessar pedidos."
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

      if (request.method === "GET") {
        return await listOrders(request, user, client);
      }

      if (request.method === "POST") {
        return await createOrder(request, user, client);
      }

      return {
        status: 405,
        jsonBody: {
          message: "Método não permitido."
        }
      };
    } catch (error) {
      context.error(error);

      if (String(error.message || "").includes("Filtro inválido")) {
        return {
          status: 400,
          jsonBody: {
            message: error.message
          }
        };
      }

      return {
        status: 500,
        jsonBody: {
          message: "Erro ao criar pedido."
        }
      };
    }
  }
});