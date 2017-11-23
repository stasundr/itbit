const querystring = require('querystring');
const request = require('request');
const VError = require('verror');
const cheerio = require('cheerio');
const crypto = require('crypto');
const _ = require('underscore');
const util = require('util');

let self;

const ItBit = function ItBit(settings) {
    self = this;

    this.key = settings.key;
    this.secret = settings.secret;

    this.serverV1 = settings.serverV1 || 'https://api.itbit.com/v1';
    this.serverV2 = settings.serverV2 || 'https://www.itbit.com/api/v2';
    this.timeout = settings.timeout || 20000; // milli seconds

    // initialize nonce to current unix time in seconds
    this.nonce = new Date().getTime();
};

function makePublicRequest(version, path, args, callback) {
    let functionName = 'ItBit.makePublicRequest()';

    let params = querystring.stringify(args);
    if (params) path = path + '?' + params;

    let server;
    if (version === 'v1') {
        server = self.serverV1;
    } else if (version === 'v2') {
        server = self.serverV2;
    } else {
        let error = new VError('%s version %s needs to be either v1 or v2', functionName, version);
        return callback(error);
    }

    let options = {
        method: 'GET',
        uri: server + path,
        headers: {
            'User-Agent': 'itBit node.js client',
            'Content-type': 'application/x-www-form-urlencoded',
        },
        json: args,
    };

    executeRequest(options, callback);
}

function makePrivateRequest(method, path, args, callback) {
    let functionName = 'ItBit.makePrivateRequest()';

    if (!self.key || !self.secret) {
        return callback(new VError('%s must provide key and secret to make a private API request.', functionName));
    }

    let uri = self.serverV1 + path;

    // compute the post data
    let postData = '';
    if (method === 'POST' || method === 'PUT') {
        postData = JSON.stringify(args);
    } else if (method === 'GET' && !_.isEmpty(args)) {
        uri += '?' + querystring.stringify(args);
    }

    let timestamp = new Date().getTime();
    let nonce = self.nonce++;

    // message is concatenated string of nonce and JSON array of secret, method, uri, json_body, nonce, timestamp
    let message = nonce + JSON.stringify([method, uri, postData, nonce.toString(), timestamp.toString()]);

    let hashBuffer = crypto
        .createHash('sha256')
        .update(message)
        .digest();

    let bufferToHash = Buffer.concat([Buffer.from(uri), hashBuffer]);

    let signer = crypto.createHmac('sha512', self.secret);

    let signature = signer.update(bufferToHash).digest('base64');

    let options = {
        method,
        uri,
        headers: {
            'User-Agent': 'itBit node.js client',
            Authorization: self.key + ':' + signature,
            'X-Auth-Timestamp': timestamp,
            'X-Auth-Nonce': nonce,
        },
        json: args,
        timeout: self.timeout,
    };

    executeRequest(options, callback);
}

function executeRequest(options, callback) {
    let functionName = 'ItBit.executeRequest()',
        json,
        requestDesc;

    if (options.method === 'GET') {
        requestDesc = util.format('%s request to url %s', options.method, options.uri);
    } else {
        requestDesc = util.format(
            '%s request to url %s with nonce %s and data %s',
            options.method,
            options.uri,
            options.headers['X-Auth-Nonce'],
            JSON.stringify(options.json)
        );
    }

    request(options, function(err, res, body) {
        let error = null; // default to no errors

        if (err) {
            error = new VError(err, '%s failed %s', functionName, requestDesc);
        } else if (!body) {
            error = new VError('%s failed %s. Not response from server', functionName, requestDesc);
        } else if (!_.isObject(body)) {
            // if request was not able to parse json response into an object
            // try and parse HTML body form response
            $ = cheerio.load(body);

            let responseBody = $('body').text();

            if (responseBody) {
                error = new VError(
                    err,
                    '%s could not parse response body from %s\nResponse body: %s',
                    functionName,
                    requestDesc,
                    responseBody
                );
            } else {
                error = new VError(err, '%s could not parse json or HTML response from %s', functionName, requestDesc);
            }
        } else if (body && body.code) {
            error = new VError(
                '%s failed %s. Error code %s, description: %s',
                functionName,
                requestDesc,
                body.code,
                body.description
            );
            error.name = body.code;
        } else if (body && body.error) {
            // the following is to trap the JSON response
            // {"error":"The itBit API is currently undergoing maintenance"}
            error = new VError('%s failed %s. Error %s', functionName, requestDesc, body.error);
            error.name = body.error;
        } else if (!(res.statusCode === 200 || res.statusCode === 201 || res.statusCode === 202)) {
            error = new VError(
                '%s failed %s. Response status code %s, response body %s',
                functionName,
                requestDesc,
                res.statusCode,
                res.body
            );
            error.name = res.statusCode;
        }

        callback(error, body);
    });
}

ItBit.prototype.getOrderBook = function(tickerSymbol, callback) {
    makePublicRequest('v1', `/markets/${tickerSymbol}/order_book`, {}, callback);
};

ItBit.prototype.getTicker = function(tickerSymbol, callback) {
    makePublicRequest('v1', `/markets/${tickerSymbol}/ticker`, {}, callback);
};

ItBit.prototype.getTrades = function(tickerSymbol, since, callback) {
    makePublicRequest('v1', `/markets/${tickerSymbol}/trades?since=${since || 0}`, {}, callback);
};

ItBit.prototype.getWallets = function(userId, callback) {
    makePrivateRequest('GET', '/wallets', { userId }, callback);
};

ItBit.prototype.getWallet = function(walletId, callback) {
    makePrivateRequest('GET', `/wallets/${walletId}`, {}, callback);
};

ItBit.prototype.getOrders = function(walletId, instrument, status, callback) {
    const args = {
        instrument,
        status,
    };

    makePrivateRequest('GET', `/wallets/${walletId}/orders`, args, callback);
};

ItBit.prototype.getOrder = function(walletId, id, callback) {
    makePrivateRequest('GET', `/wallets/${walletId}/orders/${id}`, {}, callback);
};

// price is an optional argument, if not used it must be set to null
ItBit.prototype.addOrder = function(
    walletId,
    side,
    type,
    amount,
    price,
    instrument,
    metadata,
    clientOrderIdentifier,
    callback
) {
    const args = {
        side,
        type,
        currency: instrument.slice(0, 3),
        amount: amount.toString(),
        price: price.toString(),
        instrument,
    };

    if (metadata) {
        args.metadata = metadata;
    }

    if (clientOrderIdentifier) {
        args.clientOrderIdentifier = clientOrderIdentifier;
    }

    makePrivateRequest('POST', `/wallets/${walletId}/orders`, args, callback);
};

ItBit.prototype.cancelOrder = function(walletId, id, callback) {
    makePrivateRequest('DELETE', `/wallets/${walletId}/orders/${id}`, {}, callback);
};

ItBit.prototype.getWalletTrades = function(walletId, params, callback) {
    makePrivateRequest('GET', `/wallets/${walletId}/trades`, params, callback);
};

ItBit.prototype.getFundingHistory = function(walletId, params, callback) {
    makePrivateRequest('GET', `/wallets/${walletId}/funding_history`, params, callback);
};

ItBit.prototype.cryptocurrency_withdrawals = function(walletId, currency, amount, address, callback) {
    const args = { currency, amount, address };

    makePrivateRequest('POST', `/wallets/${walletId}/cryptocurrency_withdrawals`, args, callback);
};

ItBit.prototype.cryptocurrency_deposits = function(walletId, currency, callback) {
    const args = { currency };

    makePrivateRequest('POST', `/wallets/${walletId}/cryptocurrency_deposits`, args, callback);
};

module.exports = ItBit;
