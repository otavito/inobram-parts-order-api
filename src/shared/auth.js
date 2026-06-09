const { TableClient } = require("@azure/data-tables");

let joseModulePromise;
let microsoftJwks;

function normalize(value) {
	return String(value || "").trim().toLowerCase();
}

function firstNotEmpty(values) {
	for (const value of values) {
		const str = String(value || "").trim();
		if (str) {
			return str;
		}
	}

	return "";
}

function decodeClientPrincipal(headerValue) {
	if (!headerValue) {
		return null;
	}

	try {
		const decoded = Buffer.from(headerValue, "base64").toString("utf8");
		return JSON.parse(decoded);
	} catch {
		return null;
	}
}

function getClaimValue(principal, claimTypes) {
	const claims = Array.isArray(principal?.claims) ? principal.claims : [];

	for (const claimType of claimTypes) {
		const claim = claims.find(c => String(c.typ || "").toLowerCase() === claimType.toLowerCase());

		if (claim?.val) {
			return String(claim.val).trim();
		}
	}

	return "";
}

function getGoogleIdentityFromSwa(request) {
	const principalHeader = request.headers.get("x-ms-client-principal");
	const principal = decodeClientPrincipal(principalHeader);

	if (!principal) {
		return null;
	}

	const email = firstNotEmpty([
		getClaimValue(principal, [
			"email",
			"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
			"preferred_username",
			"upn"
		]),
		principal.userDetails
	]);

	const name = firstNotEmpty([
		getClaimValue(principal, [
			"name",
			"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"
		]),
		principal.userDetails
	]);

	const provider = normalize(principal.identityProvider);

	if (!email) {
		return null;
	}

	return {
		email: normalize(email),
		name,
		provider: provider || "google"
	};
}

function getBearerTokenFromRequest(request) {
	const authorizationHeader = request.headers.get("authorization") || "";
	const [scheme, token] = authorizationHeader.split(" ");

	if (normalize(scheme) !== "bearer" || !token) {
		return "";
	}

	return token.trim();
}

function getMicrosoftJwks() {
	if (!microsoftJwks) {
		throw new Error("JWKS ainda não inicializado.");
	}

	return microsoftJwks;
}

async function getJoseModule() {
	if (!joseModulePromise) {
		joseModulePromise = import("jose");
	}

	return joseModulePromise;
}

function isValidMicrosoftIssuer(issuer) {
	const value = String(issuer || "");
	return /^https:\/\/login\.microsoftonline\.com\/[0-9a-fA-F-]+\/v2\.0$/.test(value);
}

async function getMicrosoftIdentityFromBearerToken(request) {
	const token = getBearerTokenFromRequest(request);

	if (!token) {
		return null;
	}

	const audience = process.env.MICROSOFT_CLIENT_ID;
	const tenantId = normalize(process.env.MICROSOFT_TENANT_ID);
	const jose = await getJoseModule();

	if (!microsoftJwks) {
		const jwksTenant = tenantId || "common";
		microsoftJwks = jose.createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${jwksTenant}/discovery/v2.0/keys`));
	}

	const verifyOptions = audience ? { audience } : {};

	const { payload } = await jose.jwtVerify(token, getMicrosoftJwks(), verifyOptions);

	if (!isValidMicrosoftIssuer(payload.iss)) {
		return null;
	}

	if (tenantId && !String(payload.iss || "").toLowerCase().includes(`/${tenantId}/`)) {
		return null;
	}

	const email = firstNotEmpty([
		payload.preferred_username,
		payload.email,
		payload.upn
	]);

	if (!email) {
		return null;
	}

	return {
		email: normalize(email),
		name: firstNotEmpty([payload.name, payload.given_name]),
		provider: "microsoft"
	};
}

function getAuthorizedUsersTableClient() {
	const connectionString = process.env.AUTHORIZED_USERS_STORAGE_CONNECTION_STRING || process.env.STORAGE_CONNECTION_STRING;
	const tableName = process.env.AUTHORIZED_USERS_TABLE_NAME || "AuthorizedUsers";

	if (!connectionString) {
		throw new Error("AUTHORIZED_USERS_STORAGE_CONNECTION_STRING ou STORAGE_CONNECTION_STRING não está configurada.");
	}

	return TableClient.fromConnectionString(connectionString, tableName);
}

async function listAuthorizedUsers() {
	const client = getAuthorizedUsersTableClient();
	const users = [];

	const queryOptions = {
		filter: "PartitionKey eq 'auth'"
	};

	for await (const entity of client.listEntities({ queryOptions })) {
		const email = normalize(entity?.rowKey || "");
		if (!email) {
			continue;
		}

		const isActive = String(entity?.isActive).toLowerCase() !== "false";

		users.push({
			email,
			name: firstNotEmpty([entity?.displayName, entity?.name, entity?.fullName, email]),
			role: firstNotEmpty([entity?.role, entity?.userRole]),
			isActive
		});
	}

	return users;
}

async function getAuthorizedUser(email, provider) {
	const normalizedEmail = normalize(email);
	const normalizedProvider = normalize(provider);

	if (!normalizedEmail) {
		return null;
	}

	const client = getAuthorizedUsersTableClient();

	try {
		const entity = await client.getEntity("auth", normalizedEmail);
		const entityProvider = normalize(entity.provider || "any");

		if (
			entityProvider !== "any" &&
			normalizedProvider &&
			entityProvider !== normalizedProvider
		) {
			return null;
		}

		return entity;
	} catch (error) {
		if (error.statusCode === 404) {
			return null;
		}

		throw error;
	}
}

async function requireAuthorizedUser(request) {
	const googleIdentity = getGoogleIdentityFromSwa(request);
	const microsoftIdentity = googleIdentity ? null : await getMicrosoftIdentityFromBearerToken(request);
	const identity = googleIdentity || microsoftIdentity;

	if (!identity) {
		return {
			authenticated: false,
			authorized: false,
			email: "",
			name: "",
			provider: "",
			role: ""
		};
	}

	const authorizedUser = await getAuthorizedUser(identity.email, identity.provider);
	const isActive =
		authorizedUser &&
		String(authorizedUser.isActive).toLowerCase() !== "false";
	const authorized = Boolean(authorizedUser && isActive);

	return {
		authenticated: true,
		authorized,
		email: identity.email,
		name: firstNotEmpty([
			authorizedUser?.displayName,
			authorizedUser?.name,
			authorizedUser?.fullName,
			identity.name
		]),
		provider: identity.provider,
		role: authorized ? firstNotEmpty([authorizedUser?.role, authorizedUser?.userRole]) : ""
	};
}

module.exports = {
	getGoogleIdentityFromSwa,
	getMicrosoftIdentityFromBearerToken,
	getAuthorizedUser,
	requireAuthorizedUser,
	listAuthorizedUsers
};
