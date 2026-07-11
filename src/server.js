/********************************************************************************
 * Copyright (C) 2023 CoCreate and Contributors.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 ********************************************************************************/

// Commercial Licensing Information:
// For commercial use of this software without the copyleft provisions of the AGPLv3,
// you must obtain a commercial license from CoCreate LLC.
// For details, visit <https://cocreate.app/licenses/> or contact us at sales@cocreate.app.

import fs from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';

import Config from '@cocreate/config';
import { getValueFromObject, objectToSearchParams } from '@cocreate/utils';

// Create a require context to handle legacy CommonJS module operations and cache control under ESM
const require = createRequire(import.meta.url);

let server = null;
let wsManager = null;
let crud = null;
const exclusion = { ...require.cache };
const scriptsDirectory = "./scripts";
let modulesList = {};

/**
 * Initializes the LazyLoader execution environment, loads active configurations,
 * and sets up local runtime sandbox directories.
 * Binds itself directly onto the server instance to satisfy the unified architecture contract.
 * @param {Object} Server - CoCreateServer context instance.
 */
export async function init(Server) {
    server = Server;
    wsManager = server.wsManager;
    crud = server.crud;

    try {
        await fs.mkdir(scriptsDirectory, { recursive: true });
    } catch (error) {
        console.error("[@cocreate/lazy-loader] Error creating scripts directory:", error);
        throw error;
    }
    
    wsManager.on("endpoint", (data) => {
        executeEndpoint(data);
    });


    const retrievedConfig = await Config("modules", false, false);
    if (!retrievedConfig) return;
    
    modulesList = retrievedConfig.modules || {};

    return LazyLoader;
}

/**
 * Webhook Request Gateway.
 * Exposes a clean, callable endpoint for the parent server's central routing orchestrator.
 * Strictly executes and sandboxes incoming third-party webhook requests.
 */
export async function request(req, res) {
    try {
        const urlObject = new URL(`http://${req.headers.host}${req.url}`);
        const hostname = urlObject.hostname;

        // Resolve the organization strictly for the webhook context
        let organization;
        try {
            organization = await crud.getOrganization({ host: hostname });
        } catch (error) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Organization not found for webhook integration" }));
            return;
        }

        // Expected format: /webhooks/:moduleName
        const name = urlObject.pathname.split("/")[2];
        if (name && modulesList[name]) {
            executeScriptWithTimeout(name, {
                req,
                res,
                host: hostname,
                organization,
                urlObject,
                organization_id: organization._id
            });
        } else {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Webhook module not found" }));
        }
    } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid webhook request format", message: error.message }));
    }
}

/**
 * Executes external dynamic API Gateway endpoints.
 * Now cleanly decoupled to be invoked by the central Socket Manager (wsManager) routing matrix.
 */
export async function executeEndpoint(data) {
    try {
        if (!data.method || !data.endpoint) {
            throw new Error("Request missing 'method' or 'endpoint'.");
        }

        let name = data.method.split(".")[0];
        let method = data.endpoint.split(" ")[0].toUpperCase();

        let apiConfig = await getApiConfig(data, name);
        if (!apiConfig) {
            throw new Error(`Configuration missing for API: '${name}'.`);
        }
        if (!apiConfig.url) {
            throw new Error(`Configuration error: Missing base url for API '${name}'.`);
        }

        let override = apiConfig.endpoint?.[data.endpoint] || {};
        let url = apiConfig.url;
        url = url.endsWith("/") ? url.slice(0, -1) : url;

        let endpointPath = override.path || data.endpoint.split(" ")[1];
        url += endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`;
        url += objectToSearchParams(data[name].$searchParams);

        let headers = apiConfig.headers;
        if (override.headers) {
            headers = { ...headers, ...override.headers };
        }

        let formatType = data.formatType || "json";
        const timeout = 10000;
        let options = { method, headers, timeout };

        if (!["GET", "HEAD"].includes(method)) {
            let { body } = formatRequestBody(data[name], formatType);
            options.body = body;
        }

        const response = await makeHttpRequest(url, options);
        data[name] = await response.json();

        if (wsManager) {
            wsManager.send(data);
        }
    } catch (error) {
        data.error = error.message;
        if (error.response) {
            data.status = error.response.status;
            data.statusText = error.response.statusText;
            data.responseData = error.response.data;
        }
        if (data.req) {
            data.res.writeHead(400, { "Content-Type": "application/json" });
            data.res.end(
                JSON.stringify({
                    error: data.error,
                    status: data.status,
                    statusText: data.statusText,
                    responseData: data.responseData
                })
            );
        }
        if (data.socket && wsManager) {
            wsManager.send(data);
        }
    }
}

/**
 * Formats outgoing API body structures based on requested MimeType
 */
export function formatRequestBody(payload, formatType = "json") {
    let body = null;
    let contentTypeHeader = null;

    try {
        switch (formatType.toLowerCase()) {
            case "json":
                body = JSON.stringify(payload);
                contentTypeHeader = "application/json; charset=utf-8";
                break;
            case "form-urlencoded":
                body = new URLSearchParams(payload).toString();
                contentTypeHeader = "application/x-www-form-urlencoded; charset=utf-8";
                break;
            case "text":
                if (typeof payload === "string") {
                    body = payload;
                } else if (payload && typeof payload.toString === "function") {
                    body = payload.toString();
                } else {
                    throw new Error("Payload must be a string or convertible to string for 'text' format.");
                }
                contentTypeHeader = "text/plain; charset=utf-8";
                break;
            case "multipart":
                console.warn("Multipart formatting requires specific implementation.");
                throw new Error("Multipart formatting not implemented in this basic function.");
            case "xml":
                console.warn("XML formatting requires an external library.");
                throw new Error("XML formatting not implemented in this basic function.");
            default:
                console.error(`Unsupported requestBodyFormat: ${formatType}`);
                body = JSON.stringify(payload);
                contentTypeHeader = "application/json; charset=utf-8";
        }
    } catch (error) {
        console.error(`Error formatting request body as ${formatType}:`, error);
        return { body: null, contentTypeHeader: null };
    }

    return { body, contentTypeHeader };
}

/**
 * Unified HTTP Dynamic Fetch requester
 */
export async function makeHttpRequest(url, options) {
    let controller, timeoutId;
    if (server.AbortController) {
        controller = new server.AbortController();
        timeoutId = setTimeout(() => controller.abort(), options.timeout);
        options.signal = controller.signal;
    }

    if (options.body === undefined && options.headers && options.headers["Content-Type"]) {
        delete options.headers["Content-Type"];
    }

    const fetchFn = server.fetch || global.fetch;
    if (typeof fetchFn !== "function") {
        throw new Error("No fetch implementation available.");
    }

    try {
        const response = await fetchFn(url, options);
        if (timeoutId) clearTimeout(timeoutId);

        if (!response.ok) {
            const text = await response.text();
            const error = new Error(`HTTP error! Status: ${response.status} ${response.statusText}`);
            error.response = {
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers.entries()),
                data: text
            };
            throw error;
        }
        return response;
    } catch (error) {
        if (timeoutId) clearTimeout(timeoutId);
        throw error;
    }
}

/**
 * Executes VM sandboxed or dynamically imported modules with custom inactivity timeouts
 */
export async function executeScriptWithTimeout(name, data) {
    try {
        if (modulesList[name].initialize || modulesList[name].initialize === "") {
            if (data.req) {
                data = await webhooks(modulesList[name], data, name);
            } else {
                data = await api(modulesList[name], data);
            }
        } else {
            if (!modulesList[name].content) {
                if (modulesList[name].path) {
                    modulesList[name].content = require(modulesList[name].path);
                } else {
                    try {
                        const scriptPath = path.join(scriptsDirectory, `${name}.js`);
                        await fs.access(scriptPath);
                        modulesList[name].content = await fs.readFile(scriptPath, "utf8");
                    } catch {
                        modulesList[name].content = await fetchScriptFromDatabaseAndSave(
                            name,
                            modulesList[name],
                            data
                        );
                    }
                }
            }

            if (modulesList[name].content) {
                data.apis = await getApiConfig(data, name);
                data.crud = crud;
                data = await modulesList[name].content.send(data);
                delete data.apis;
                delete data.crud;
            } else return;
        }

        if (data.socket && wsManager) wsManager.send(data);

        if (modulesList[name].unload === false || modulesList[name].unload === "false") {
            return;
        } else if (modulesList[name].unload === true || modulesList[name].unload === "true") {
            console.log("config should unload after completion");
        } else if ((modulesList[name].unload = parseInt(modulesList[name].unload, 10))) {
            if (modulesList[name].timeout) {
                clearTimeout(modulesList[name].timeout);
            } else if (!modulesList[name].path) {
                modulesList[name].context = vm.createContext({});
                const script = new vm.Script(modulesList[name].content);
                script.runInContext(modulesList[name].context);
            }

            const timeout = setTimeout(() => {
                delete modulesList[name].timeout;
                delete modulesList[name].context;
                delete modulesList[name].content;
                console.log(`Module ${name} removed due to inactivity.`);
                clearModuleCache(name);
            }, modulesList[name].unload);

            modulesList[name].timeout = timeout;
        }
    } catch (error) {
        data.error = error.message;
        if (data.req) {
            data.res.writeHead(400, { "Content-Type": "text/plain" });
            data.res.end(`Lazyload Error: ${error.message}`);
        }
        if (data.socket && wsManager) wsManager.send(data);
    }
}

/**
 * Resolves and builds dynamic library integrations (e.g. Stripe, Sendgrid SDKs)
 */
export async function api(config, data) {
    try {
        const methodPath = data.method.split(".");
        const name = methodPath.shift();

        const apis = await getApiConfig(data, name);
        const key = apis.key;
        if (!key) throw new Error(`Missing ${name} key in organization apis object`);

        let instance;
        try {
            instance = require(config.path);
        } catch (err) {
            if (err.code === "ERR_REQUIRE_ESM") {
                instance = await import(config.path);
            } else {
                throw err;
            }
        }

        if (config.initialize) {
            if (Array.isArray(config.initialize)) {
                const initializations = [];
                for (let i = 0; i < config.initialize.length; i++) {
                    const initialize = config.initialize[i].split(".");
                    initializations.push(instance);
                    for (let j = 0; j < initialize.length; j++) {
                        if (initializations[i][initialize[j]]) {
                            initializations[i] = initializations[i][initialize[j]];
                        } else {
                            throw new Error(`Service path ${config.initialize[i]} is incorrect at ${initialize[j]}`);
                        }
                    }
                }
                instance = new initializations[1](new initializations[0](key));
            } else {
                const initialize = config.initialize.split(".");
                for (let i = 0; i < initialize.length; i++) {
                    if (instance[initialize[i]]) {
                        instance = instance[initialize[i]];
                    } else {
                        throw new Error(`Service path ${config.initialize} is incorrect at ${initialize[i]}`);
                    }
                }
                instance = new instance(key);
            }
        } else {
            instance = new instance(key);
        }

        let params = [], mainParam = false;
        for (let i = 0; true; i++) {
            if (`$param[${i}]` in data[name]) {
                params.push(data[name][`$param[${i}]`]);
                delete data[name][`$param[${i}]`];
            } else if (!mainParam) {
                params.push(data[name]);
                mainParam = true;
            } else {
                break;
            }
        }

        data[name] = await executeMethod(data.method, methodPath, instance, params);
        return data;
    } catch (error) {
        data.error = error.message;
        return data;
    }
}

/**
 * Resolves incoming platform webhooks dynamically
 */
export async function webhooks(config, data, name) {
    try {
        const apis = await getApiConfig(data, name);
        const key = apis.key;
        if (!key) throw new Error(`Missing ${name} key in organization apis object`);

        let webhookName = data.req.url.split("/");
        webhookName = webhookName[webhookName.length - 1];

        const webhook = apis.webhooks[webhookName];
        if (!webhook) throw new Error(`Webhook ${name} ${webhookName} is not defined`);

        let eventDataKey = webhook.eventDataKey || apis.eventDataKey;
        if (!eventDataKey) throw new Error(`Webhook ${name} eventKey is not defined`);

        let eventNameKey = webhook.eventNameKey || apis.eventNameKey;
        if (!eventNameKey) throw new Error(`Webhook ${name} eventNameKey is not defined`);

        if (!webhook.events) throw new Error(`Webhook ${name} events are not defined`);

        data.rawBody = "";
        await new Promise((resolve, reject) => {
            data.req.on("data", (chunk) => {
                data.rawBody += chunk.toString();
            });
            data.req.on("end", () => {
                resolve();
            });
            data.req.on("error", (err) => {
                reject(err);
            });
        });

        let parameters, method;

        if (webhook.authenticate && webhook.authenticate.method) {
            method = webhook.authenticate.method;
        } else if (apis.authenticate && apis.authenticate.method) {
            method = apis.authenticate.method;
        } else {
            throw new Error(`Webhook ${name} authenticate method is not defined`);
        }

        if (webhook.authenticate && webhook.authenticate.parameters) {
            parameters = webhook.authenticate.parameters;
        } else if (apis.authenticate && apis.authenticate.parameters) {
            parameters = apis.authenticate.parameters;
        } else {
            throw new Error(`Webhook ${name} authenticate parameters is not defined`);
        }

        let event;
        if (!method) {
            if (parameters[0] !== parameters[1]) {
                throw new Error("Webhook secret failed for " + name + ". Unauthorized access attempt.");
            }
            event = JSON.parse(data.rawBody);
        } else {
            const service = require(config.path);
            let instance;
            if (config.initialize) {
                instance = new service[config.initialize](key);
            } else {
                instance = new service(key);
            }

            const methodPath = method.split(".");
            await processOperators(data, "", parameters);
            event = await executeMethod(method, methodPath, instance, parameters);
        }

        let eventName = getValueFromObject(event, eventNameKey);
        if (!eventName) {
            throw new Error(`Webhook ${name} eventNameKey: ${eventNameKey} could not be found in the event.`);
        }

        let eventData = getValueFromObject(event, eventDataKey);
        if (!eventData) {
            throw new Error(`Webhook ${name} eventDataKey: ${eventDataKey} could not be found in the event.`);
        }

        let execute = webhook.events[eventName];
        if (execute) {
            execute = await processOperators(data, event, execute);
        }

        data.res.writeHead(200, { "Content-Type": "application/json" });
        data.res.end(JSON.stringify({ message: "Webhook received and processed" }));
        return data;
    } catch (error) {
        data.error = error.message;
        data.res.writeHead(400, { "Content-Type": "text/plain" });
        data.res.end(error.message);
        return data;
    }
}

/**
 * Dynamic Operator router (resolves custom DB/Socket variables in JSON trees)
 */
export async function processOperators(data, event, execute) {
    if (Array.isArray(execute)) {
        for (let index = 0; index < execute.length; index++) {
            execute[index] = await processOperators(data, event, execute[index]);
        }
    } else if (typeof execute === "object" && execute !== null) {
        for (let key of Object.keys(execute)) {
            if (key.startsWith("$") && !["$storage", "$database", "$array", "$filter"].includes(key)) {
                execute[key] = await processOperator(data, event, key, execute[key]);
            } else if (typeof execute[key] === "string" && execute[key].startsWith("$") && !["$storage", "$database", "$array", "$filter"].includes(execute[key])) {
                execute[key] = await processOperator(data, event, execute[key]);
            } else if (Array.isArray(execute[key])) {
                execute[key] = await processOperators(data, event, execute[key]);
            } else if (typeof execute[key] === "object" && execute[key] !== null) {
                execute[key] = await processOperators(data, event, execute[key]);
            }
        }
    } else if (typeof execute === "string" && execute.startsWith("$") && !["$storage", "$database", "$array", "$filter"].includes(execute)) {
        execute = await processOperator(data, event, execute);
    }

    return execute;
}

/**
 * Resolves individual operator payloads dynamically
 */
export async function processOperator(data, event, operator, context) {
    let result;
    if (operator.startsWith("$data.")) {
        return getValueFromObject(data, operator.substring(6));
    } else if (operator.startsWith("$req")) {
        return getValueFromObject(data, operator.substring(1));
    } else if (operator.startsWith("$header")) {
        return getValueFromObject(data.req, operator.substring(1));
    } else if (operator.startsWith("$rawBody")) {
        return getValueFromObject(data, operator.substring(1));
    } else if (operator.startsWith("$crud")) {
        let results = context;
        let isObject = false;
        if (!Array.isArray(results)) {
            isObject = true;
            results = [results];
        }

        for (let i = 0; i < results.length; i++) {
            results[i] = await processOperators(data, event, results[i]);
            results[i] = await crud.send(results[i]);
            if (operator.startsWith("$crud.")) {
                results[i] = getValueFromObject(operator, operator.substring(6));
            }
            results[i] = await processOperators(data, event, results[i]);
        }

        if (isObject) results = results[0];
        return results;
    } else if (operator.startsWith("$socket")) {
        context = await processOperators(data, event, context);
        result = await wsManager.send(context);
        if (operator.startsWith("$socket.")) {
            result = getValueFromObject(operator, operator.substring(6));
        }
        return await processOperators(data, event, result);
    } else if (operator.startsWith("$api")) {
        context = await processOperators(data, event, context);
        let name = context.method.split(".")[0];
        result = executeScriptWithTimeout(name, context);
        if (operator.startsWith("$api.")) {
            result = getValueFromObject(event, operator.substring(5));
        }
        return await processOperators(data, event, result);
    } else if (operator.startsWith("$event")) {
        if (operator.startsWith("$event.")) {
            result = getValueFromObject(event, operator.substring(7));
        }
        return await processOperators(data, event, result);
    }

    return operator;
}

/**
 * Resolves organization integration configuration variables
 */
export async function getApiConfig(data, name) {
    let organization = await crud.getOrganization(data);
    if (organization.error) throw new Error(organization.error);
    if (!organization.apis) throw new Error("Missing apis object in organization object");
    if (!organization.apis[name]) throw new Error(`Missing ${name} in organization apis object`);
    return organization.apis[name];
}

/**
 * Dynamically pulls missing server scripts from database configurations and caches to local disk
 */
export async function fetchScriptFromDatabaseAndSave(name, moduleConfig, dataContext) {
    const organization_id = dataContext?.organization_id || moduleConfig?.object?.organization_id;
    let queryData = {
        method: "object.read",
        host: moduleConfig.object.hostname,
        array: moduleConfig.array,
        $filter: {
            query: {
                host: { $in: [moduleConfig.object.hostname, "*"] },
                pathname: moduleConfig.object.pathname
            },
            limit: 1
        },
        organization_id
    };

    let file = await crud.send(queryData);
    let src;

    if (file && file.object && file.object[0]) {
        src = file.object[0].src;
    } else {
        throw new Error("Script not found in database");
    }

    const scriptPath = path.join(scriptsDirectory, `${name}.js`);
    await fs.writeFile(scriptPath, src);

    return src;
}

/**
 * Evaluates module tree dependencies
 */
export function getModuleDependencies(modulePath) {
    let moduleObj = require.cache[modulePath];
    if (!moduleObj) return [];
    return moduleObj.children.map((child) => child.id);
}

/**
 * Asserts whether a dynamic script is locked by adjacent procedures
 */
export function isModuleUsedElsewhere(modulePath) {
    return Object.keys(require.cache).some((cachePath) => {
        const moduleObj = require.cache[cachePath];
        return moduleObj.children.some((child) => child.id === modulePath && cachePath !== modulePath);
    });
}

/**
 * Safely flushes dynamic script memory footprints from Node processes
 */
export function clearModuleCache(moduleName) {
    try {
        const modulePath = require.resolve(moduleName);
        const dependencies = getModuleDependencies(modulePath);

        if (isModuleUsedElsewhere(modulePath)) {
            console.log(`Module ${moduleName} is a dependency of other modules.`);
            return;
        }

        delete require.cache[modulePath];
        console.log(`Module ${moduleName} has been removed from cache.`);
        dependencies.forEach((depPath) => {
            clearModuleCache(depPath);
        });
    } catch (error) {
        console.error(`Error clearing module cache for ${moduleName}: ${error.message}`);
    }
}

/**
 * Execution helper: Dynamic deep-method invocation loop
 */
export async function executeMethod(method, methodPath, instance, params) {
    try {
        switch (methodPath.length) {
            case 1:
                return await instance[methodPath[0]](...params);
            case 2:
                return await instance[methodPath[0]][methodPath[1]](...params);
            case 3:
                return await instance[methodPath[0]][methodPath[1]][methodPath[2]](...params);
            case 4:
                return await instance[methodPath[0]][methodPath[1]][methodPath[2]][methodPath[3]](...params);
            case 5:
                return await instance[methodPath[0]][methodPath[1]][methodPath[2]][methodPath[3]][methodPath[4]](...params);
            case 6:
                return await instance[methodPath[0]][methodPath[1]][methodPath[2]][methodPath[3]][methodPath[4]][methodPath[5]](...params);
            case 7:
                return await instance[methodPath[0]][methodPath[1]][methodPath[2]][methodPath[3]][methodPath[4]][methodPath[5]][methodPath[6]](...params);
            case 8:
                return await instance[methodPath[0]][methodPath[1]][methodPath[2]][methodPath[3]][methodPath[4]][methodPath[5]][methodPath[6]][methodPath[7]](...params);
            default:
                const methodName = methodPath.pop();
                let Method = instance;
                for (let i = 0; i < methodPath.length; i++) {
                    Method = Method[methodPath[i]];
                    if (Method === undefined) {
                        throw new Error(`Method ${methodPath[i]} not found using ${method}.`);
                    }
                }

                if (typeof Method[methodName] !== "function") {
                    throw new Error(`Method ${method} is not a function.`);
                }

                return await Method[methodName](...params);
        }
    } catch (error) {
        throw new Error(error);
    }
}

const LazyLoader = {
    init,
    request,
    executeEndpoint,
    formatRequestBody,
    makeHttpRequest,
    executeScriptWithTimeout,
    api,
    webhooks,
    processOperators,
    processOperator,
    getApiConfig,
    fetchScriptFromDatabaseAndSave
};

export default LazyLoader;