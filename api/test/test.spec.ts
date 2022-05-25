import { instrumentTests, validate } from '@heliosphere/opentelemetry-sdk';
const testTraceManager = instrumentTests({ apiToken: process.env.HS_TOKEN });

import 'mocha';
import assert from 'assert';
import axios from 'axios';
import { Agent } from 'https';

const hostname = process.env.CUSTOM_HOSTNAME || 'localhost';
const useHttps = process.env.USE_HTTPS === 'true';
const scheme = useHttps ? 'https' : 'http';
const httpsAgent = useHttps ? new Agent({ rejectUnauthorized: false }) : undefined;

function createRandomString(length) {
    return [...Array(length)].map((i) => (~~(Math.random() * 36)).toString(36)).join('');
}

describe('api-service', function () {
    this.timeout(60_000);

    this.beforeAll(async () => {
        await createUser('demo2@gethelios.dev', 'Helios Demo');
    });

    async function createUser(email, name) {
        const url = 'http://localhost:8081/users';
        const headers = {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'user-agent': 'axios/0.21.4',
        };

        const data = {
            email,
            name,
        };
        const response = await axios.post(url, data, { headers });
        assert.equal(response.status, 200, 'HTTP POST request in setup to http://localhost:8081/users validation failed');
    }

    it('performs deposit e2e', async () => {
        // Set up
        const email = `demo+${createRandomString(10)}test@gethelios.dev`;
        const userName = 'Heliosphere Demo Test User';
        const amount = 1000;
        const USD_currency = 'USD';
        const expectedExchangeRate = 1;

        await createUser(email, userName);

        // Flow trigger.
        const url = `${scheme}://${hostname}:8080/deposit`;
        const headers = {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'user-agent': 'axios/0.21.4',
            'x-helios-data': '2b1ada21-50a7-4eb1-8399-3ddf904bb2c5',
        };
        const data = {
            email,
            amount,
            currency: USD_currency,
        };
        const response = await axios.post(url, data, { headers, httpsAgent });
        assert.equal(
            response.status,
            200,
            `HTTP POST request to ${scheme}://${hostname}:8080/deposit validation failed`
        );

        // Validate HTTP POST requests sent to users-service.
        const httpPostSpans1 = await testTraceManager.findSpans({
            service: 'users-service',
            operation: 'POST /users/by-email',
            spanSelectors: [
                { key: 'http.host', value: 'users-service:8081' },
                { key: 'http.method', value: 'POST' },
                { key: 'http.target', value: '/users/by-email' },
            ],
        });
        assert.ok(
            httpPostSpans1?.length,
            'Operation POST /users/by-email in service users-service did not occur'
        );
        validate(httpPostSpans1, (span) => {
            assert.equal(span.attributes['http.status_code'], 200);
        });

        // Validate PostgreSQL SELECT commands sent by users-service.
        const pgSelectSpans = await testTraceManager.findSpans({
            service: 'users-service',
            operation: 'pg.query:SELECT',
            spanSelectors: [
                { key: 'db.name', value: 'users' },
                { key: 'db.system', value: 'postgresql' },
            ],
        });
        assert.ok(
            pgSelectSpans?.length,
            'Operation pg.query:SELECT in service users-service did not occur'
        );
        validate(pgSelectSpans, (span) => {
            assert.ok(
                (span.attributes['db.statement'] as string),
                'SELECT "TypeormUser"."id" AS "TypeormUser_id", "TypeormUser"."name" AS "TypeormUser_name", "TypeormUser"."email" AS "TypeormUser_email" FROM "users" "TypeormUser"'
            );
            assert.ok(
                (span.attributes['db.query_result'] as string).includes(
                    `"TypeormUser_email":"${email}"`
                )
            );
        });

        // Validate Kafka messages sent by api-service.
        const kafkaSendMessageSpans1 = await testTraceManager.findSpans({
            service: 'api-service',
            operation: 'kafka.sendMessage',
            spanSelectors: { key: 'messaging.destination', value: 'deposits' },
        });
        assert.ok(
            kafkaSendMessageSpans1?.length,
            'Operation kafka.sendMessage in service api-service did not occur'
        );
        validate(kafkaSendMessageSpans1, (span) => {
            const messagingPayload = {
                email,
                amount,
                currency: USD_currency,
            };
            assert.deepEqual(
                JSON.parse(span.attributes['messaging.payload'] as string),
                messagingPayload
            );
        });

        // Validate Kafka messages received by accounts-service.
        const kafkaEachMessageSpans1 = await testTraceManager.findSpans({
            service: 'accounts-service',
            operation: 'kafka.eachMessage',
            spanSelectors: { key: 'messaging.destination', value: 'deposits' },
        });
        assert.ok(
            kafkaEachMessageSpans1?.length,
            'Operation kafka.eachMessage in service accounts-service did not occur'
        );
        validate(kafkaEachMessageSpans1, (span) => {
            const messagingPayload = {
                email,
                amount,
                currency: USD_currency,
            };
            assert.deepEqual(
                JSON.parse(span.attributes['messaging.payload'] as string),
                messagingPayload
            );
        });

        // Validate HTTP GET requests sent to financial-service.
        const httpGetSpans = await testTraceManager.findSpans({
            service: 'financial-service',
            operation: '/exchange_rate',
            spanSelectors: [
                { key: 'http.host', value: 'financial-service:8082' },
                { key: 'http.method', value: 'GET' },
                {
                    key: 'http.target',
                    value: `/exchange_rate?amount=${amount}&currency=${USD_currency}`,
                },
            ],
        });
        assert.ok(
            httpGetSpans?.length,
            'Operation /exchange_rate in service financial-service did not occur'
        );
        validate(httpGetSpans, (span) => {
            assert.equal(span.attributes['http.status_code'], 200);
            assert.equal(
                span.attributes['http.response.body'],
                `{"exchangeRate":${expectedExchangeRate}.0,"usdAmount":${amount}.0} `
            );
        });

        // Validate HTTP POST requests sent from accounts-service.
        const httpPostSpans2 = await testTraceManager.findSpans({
            service: 'accounts-service',
            operation: 'HTTPS POST',
            spanSelectors: [
                { key: 'http.host', value: 'api.stripe.com:443' },
                { key: 'http.method', value: 'POST' },
                { key: 'http.target', value: '/v1/payment_intents' },
            ],
        });
        assert.ok(
            httpPostSpans2?.length,
            'Operation HTTPS POST in service accounts-service did not occur'
        );
        validate(httpPostSpans2, (span) => {
            assert.equal(span.attributes['http.status_code'], 200);
            assert.equal(
                span.attributes['http.request.body'],
                `amount=${amount*100}&currency=${USD_currency}`
            );
        });

        // Validate DynamoDB put requests sent by accounts-service.
        const dynamodbPutSpans = await testTraceManager.findSpans({
            service: 'accounts-service',
            operation: 'aws.dynamodb.putItem',
            spanSelectors: [
                { key: 'aws.operation', value: 'putItem' },
                { key: 'db.name', value: 'accounts' },
            ],
        });
        assert.ok(
            dynamodbPutSpans?.length,
            'Operation aws.dynamodb.putItem in service accounts-service did not occur'
        );
        validate(dynamodbPutSpans, (span) => {
            const dbStatement = {
                TableName: 'accounts',
                Item: {
                    email: { S: email },
                    amount: { N: amount },
                },
            };
            assert.deepEqual(
                JSON.parse(span.attributes['db.statement'] as string),
                dbStatement
            );
        });

        // Validate Kafka messages sent by accounts-service.
        const kafkaSendMessageSpans2 = await testTraceManager.findSpans({
            service: 'accounts-service',
            operation: 'kafka.sendMessage',
            spanSelectors: { key: 'messaging.destination', value: 'emails' },
        });
        assert.ok(
            kafkaSendMessageSpans2?.length,
            'Operation kafka.sendMessage in service accounts-service did not occur'
        );
        validate(kafkaSendMessageSpans2, (span) => {
            const messagingPayload = {
                email,
                amount,
                balance: amount,
            };
            assert.deepEqual(
                JSON.parse(span.attributes['messaging.payload'] as string),
                messagingPayload
            );
        });

        // Validate Kafka messages received by emails-service.
        const kafkaEachMessageSpans2 = await testTraceManager.findSpans({
            service: 'emails-service',
            operation: 'kafka.eachMessage',
            spanSelectors: { key: 'messaging.destination', value: 'emails' },
        });
        assert.ok(
            kafkaEachMessageSpans2?.length,
            'Operation kafka.eachMessage in service emails-service did not occur'
        );

        // Validate SES email messages sent by emails-service.
        const sesSendSpans = await testTraceManager.findSpans({
            service: 'emails-service',
            operation: 'aws.ses.sendEmail',
            spanSelectors: {
                key: 'aws.ses.sender',
                value: 'demo@gethelios.dev',
            },
        });
        assert.ok(
            sesSendSpans?.length,
            'Operation aws.ses.sendEmail in service emails-service did not occur'
        );
        validate(sesSendSpans, (span) => {
            assert.ok(
                (span.attributes['aws.ses.recipients'] as string).includes(email)
            );
            assert.equal(
                span.attributes['aws.ses.subject'],
                'A deposit has been made to your account'
            );
            assert.equal(
                span.attributes['aws.ses.body'],
                `You have received ${amount} dollars, your current balance is ${amount}`
            );
        });
    });

    it('fails to deposit when amount is negative', async () => {
        // Set up
        const email = `demo@gethelios.dev`;
        const negAmount = -1000;
        const USD_currency = 'USD';
        const expectedExchangeRate = 1;

        // Flow trigger.
        const url = `${scheme}://${hostname}:8080/deposit`;
        const headers = {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'user-agent': 'axios/0.21.4',
            'x-helios-data': '36d20d9c-71ca-479a-89eb-b499eb490289',
        };
        const data = {
            email,
            amount: negAmount,
            currency: USD_currency,
        };
        const response = await axios.post(url, data, { headers, httpsAgent });
        assert.equal(
            response.status,
            200,
            `HTTP POST request to ${scheme}://${hostname}:8080/deposit validation failed`
        );

        // Validate HTTP GET requests sent to financial-service.
        const httpGetSpans = await testTraceManager.findSpans({
            service: 'financial-service',
            operation: '/exchange_rate',
            spanSelectors: [
                { key: 'http.host', value: 'financial-service:8082' },
                { key: 'http.method', value: 'GET' },
                {
                    key: 'http.target',
                    value: `/exchange_rate?amount=${negAmount}&currency=${USD_currency}`,
                },
            ],
        });
        assert.ok(
            httpGetSpans?.length,
            'Operation /exchange_rate in service financial-service did not occur'
        );
        validate(httpGetSpans, (span) => {
            assert.equal(span.attributes['http.status_code'], 200);
            assert.equal(
                span.attributes['http.response.body'],
                `{"exchangeRate":${expectedExchangeRate}.0,"usdAmount":${negAmount}.0} `
            );
        });

        // Validate Kafka messages received by accounts-service.
        const kafkaEachMessageSpans1 = await testTraceManager.findSpans({
            service: 'accounts-service',
            operation: 'kafka.eachMessage',
            spanSelectors: { key: 'messaging.destination', value: 'deposits' },
        });
        assert.ok(
            kafkaEachMessageSpans1?.length,
            'Operation kafka.eachMessage in service accounts-service did not occur'
        );
        validate(kafkaEachMessageSpans1, (span) => {
            const messagingPayload = {
                email,
                amount: negAmount,
                currency: USD_currency,
            };
            assert.deepEqual(
                JSON.parse(span.attributes['messaging.payload'] as string),
                messagingPayload
            );
        });

        // Validate Kafka messages sent by api-service.
        const kafkaSendMessageSpans1 = await testTraceManager.findSpans({
            service: 'api-service',
            operation: 'kafka.sendMessage',
            spanSelectors: { key: 'messaging.destination', value: 'deposits' },
        });
        assert.ok(
            kafkaSendMessageSpans1?.length,
            'Operation kafka.sendMessage in service api-service did not occur'
        );
        validate(kafkaSendMessageSpans1, (span) => {
            const messagingPayload = {
                email,
                amount: negAmount,
                currency: USD_currency,
            };
            assert.deepEqual(
                JSON.parse(span.attributes['messaging.payload'] as string),
                messagingPayload
            );
        });

        // Validate HTTP POST requests sent from accounts-service.
        const httpPostSpans2 = await testTraceManager.findSpans({
            service: 'accounts-service',
            operation: 'HTTPS POST',
            spanSelectors: [
                { key: 'http.host', value: 'api.stripe.com:443' },
                { key: 'http.method', value: 'POST' },
                { key: 'http.target', value: '/v1/payment_intents' },
            ],
        });
        assert.ok(
            httpPostSpans2?.length,
            'Operation HTTPS POST in service accounts-service did not occur'
        );
        validate(httpPostSpans2, (span) => {
            assert.equal(span.attributes['http.status_code'], 400);
            assert.equal(
                span.attributes['http.request.body'],
                `amount=${negAmount*100}&currency=${USD_currency}`
            );
            const httpResponseBody = {
                error: {
                    code: 'parameter_invalid_integer',
                    doc_url:
                        'https://stripe.com/docs/error-codes/parameter-invalid-integer',
                    message: 'This value must be greater than or equal to 1.',
                    param: 'amount',
                    type: 'invalid_request_error',
                },
            };
            assert.deepEqual(JSON.parse(span.attributes['http.response.body'] as string), httpResponseBody);

        });
    });

    // This is a failing test!!!!
    it('returns user\'s balance', async () => {
        const nonExistingUserId = 34897;
        // Flow trigger.
        const url = `${scheme}://${hostname}:8080/users/${nonExistingUserId}/balance`;
        const headers = {
            accept: 'application/json, text/plain, */*',
            'user-agent': 'axios/0.21.4',
            'x-helios-data': 'b5cb7df1-7b9e-4b70-a01d-514a5a0f7920',
        };
        try {
            const response = await axios.get(url, { headers, httpsAgent });
            // expect(response.status).toEqual(200);
        } catch (err) {}

        // Validate HTTP GET requests sent to users-service.
        const httpGetSpans = await testTraceManager.findSpans({
            service: 'users-service',
            operation: 'GET /users',
            spanSelectors: [
                { key: 'http.host', value: 'users-service:8081' },
                { key: 'http.method', value: 'GET' },
                { key: 'http.target', value: '/users' },
            ],
        });
        assert.ok(
            httpGetSpans?.length,
            'Operation GET /users in service users-service did not occur'
        );
        validate(httpGetSpans, (span) => {
            assert.equal(span.attributes['http.status_code'], 200);
        });

        // Validate PostgreSQL SELECT commands sent by users-service.
        const pgSelectSpans = await testTraceManager.findSpans({
            service: 'users-service',
            operation: 'pg.query:SELECT',
            spanSelectors: [
                { key: 'db.name', value: 'users' },
                { key: 'db.system', value: 'postgresql' },
            ],
        });
        assert.ok(
            pgSelectSpans?.length,
            'Operation pg.query:SELECT in service users-service did not occur'
        );
        validate(pgSelectSpans, (span) => {
            // ***** Commented out on purpose *****
            // const dbQueryResult = {
            //     rowCount: 1,
            //     rows: [
            //         {
            //             TypeormUser_id: 23,
            //             TypeormUser_name: 'Robinson Crusoe',
            //             TypeormUser_email: 'robinson.crusoe@globex.com',
            //         },
            //     ],
            // };
            // assert.deepEqual(
            //     JSON.parse(span.attributes['db.query_result'] as string),
            //     dbQueryResult
            // );
        });

        // Validate DynamoDB get requests sent by api-service.
        const dynamodbGetSpans = await testTraceManager.findSpans({
            service: 'api-service',
            operation: 'aws.dynamodb.getItem',
            spanSelectors: [
                { key: 'aws.operation', value: 'getItem' },
                { key: 'db.name', value: 'accounts' },
            ],
        });
        assert.ok(
            dynamodbGetSpans?.length,
            'Operation aws.dynamodb.getItem in service api-service did not occur'
        );
    });

    // This is a failing test!!!!
    it('sends an email upon deposit', async () => {
        // Set up
        const nonEmail = `nonemailaddress${createRandomString(10)}`;
        const userName = 'Non email User';
        const amount = 1000;
        const USD_currency = 'USD';
        const expectedExchangeRate = 1;

        await createUser(nonEmail, userName);

        // Flow trigger.
        const url = `${scheme}://${hostname}:8080/deposit`;
        const headers = {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'user-agent': 'axios/0.24.0',
            'x-helios-data': '0fcae704-70ee-44fa-9855-4df8d53bf960',
        };

        const data = {
            email: nonEmail,
            amount,
            currency: USD_currency,
        };
        const response = await axios.post(url, data, { headers, httpsAgent });
        assert.equal(
            response.status,
            200,
            `HTTP POST request to ${scheme}://${hostname}:8080/deposit validation failed`
        );

        // Validate HTTP POST requests sent to users-service.
        const httpPostSpans1 = await testTraceManager.findSpans({
            service: 'users-service',
            operation: 'POST /users/by-email',
            spanSelectors: [
                { key: 'http.host', value: 'users-service:8081' },
                { key: 'http.method', value: 'POST' },
                { key: 'http.target', value: '/users/by-email' },
            ],
        });
        assert.ok(
            httpPostSpans1?.length,
            'Operation POST /users/by-email in service users-service did not occur'
        );
        validate(httpPostSpans1, (span) => {
            assert.equal(span.attributes['http.status_code'], 200);
        });

        // Validate PostgreSQL SELECT commands sent by users-service.
        const pgSelectSpans = await testTraceManager.findSpans({
            service: 'users-service',
            operation: 'pg.query:SELECT',
            spanSelectors: [
                { key: 'db.name', value: 'users' },
                { key: 'db.system', value: 'postgresql' },
            ],
        });
        assert.ok(
            pgSelectSpans?.length,
            'Operation pg.query:SELECT in service users-service did not occur'
        );
        validate(pgSelectSpans, (span) => {
            assert.ok(
                (span.attributes['db.statement'] as string),
                'SELECT "TypeormUser"."id" AS "TypeormUser_id", "TypeormUser"."name" AS "TypeormUser_name", "TypeormUser"."email" AS "TypeormUser_email" FROM "users" "TypeormUser"'
            );
            assert.ok(
                (span.attributes['db.query_result'] as string).includes(
                    `"TypeormUser_email":"${nonEmail}"`
                )
            );
        });

        // Validate Kafka messages sent by api-service.
        const kafkaSendMessageSpans1 = await testTraceManager.findSpans({
            service: 'api-service',
            operation: 'kafka.sendMessage',
            spanSelectors: { key: 'messaging.destination', value: 'deposits' },
        });
        assert.ok(
            kafkaSendMessageSpans1?.length,
            'Operation kafka.sendMessage in service api-service did not occur'
        );
        validate(kafkaSendMessageSpans1, (span) => {
            const messagingPayload = {
                email: nonEmail,
                amount,
                currency: USD_currency,
            };
            assert.deepEqual(
                JSON.parse(span.attributes['messaging.payload'] as string),
                messagingPayload
            );
        });

        // Validate Kafka messages received by accounts-service.
        const kafkaEachMessageSpans1 = await testTraceManager.findSpans({
            service: 'accounts-service',
            operation: 'kafka.eachMessage',
            spanSelectors: { key: 'messaging.destination', value: 'deposits' },
        });
        assert.ok(
            kafkaEachMessageSpans1?.length,
            'Operation kafka.eachMessage in service accounts-service did not occur'
        );
        validate(kafkaEachMessageSpans1, (span) => {
            const messagingPayload = {
                email: nonEmail,
                amount,
                currency: USD_currency,
            };
            assert.deepEqual(
                JSON.parse(span.attributes['messaging.payload'] as string),
                messagingPayload
            );
        });

        // Validate HTTP GET requests sent to financial-service.
        const httpGetSpans = await testTraceManager.findSpans({
            service: 'financial-service',
            operation: '/exchange_rate',
            spanSelectors: [
                { key: 'http.host', value: 'financial-service:8082' },
                { key: 'http.method', value: 'GET' },
                {
                    key: 'http.target',
                    value: `/exchange_rate?amount=${amount}&currency=${USD_currency}`,
                },
            ],
        });
        assert.ok(
            httpGetSpans?.length,
            'Operation /exchange_rate in service financial-service did not occur'
        );
        validate(httpGetSpans, (span) => {
            assert.equal(span.attributes['http.status_code'], 200);
            assert.equal(
                span.attributes['http.response.body'],
                `{"exchangeRate":${expectedExchangeRate}.0,"usdAmount":${amount}.0} `
            );
        });

        // Validate HTTP POST requests sent from accounts-service.
        const httpPostSpans2 = await testTraceManager.findSpans({
            service: 'accounts-service',
            operation: 'HTTPS POST',
            spanSelectors: [
                { key: 'http.host', value: 'api.stripe.com:443' },
                { key: 'http.method', value: 'POST' },
                { key: 'http.target', value: '/v1/payment_intents' },
            ],
        });
        assert.ok(
            httpPostSpans2?.length,
            'Operation HTTPS POST in service accounts-service did not occur'
        );
        validate(httpPostSpans2, (span) => {
            assert.equal(span.attributes['http.status_code'], 200);
            assert.equal(
                span.attributes['http.request.body'],
                `amount=${amount*100}&currency=${USD_currency}`
            );
        });

        // Validate DynamoDB put requests sent by accounts-service.
        const dynamodbPutSpans = await testTraceManager.findSpans({
            service: 'accounts-service',
            operation: 'aws.dynamodb.putItem',
            spanSelectors: [
                { key: 'aws.operation', value: 'putItem' },
                { key: 'db.name', value: 'accounts' },
            ],
        });
        assert.ok(
            dynamodbPutSpans?.length,
            'Operation aws.dynamodb.putItem in service accounts-service did not occur'
        );
        validate(dynamodbPutSpans, (span) => {
            const dbStatement = {
                TableName: 'accounts',
                Item: {
                    email: { S: nonEmail },
                    amount: { N: amount },
                },
            };
            assert.deepEqual(
                JSON.parse(span.attributes['db.statement'] as string),
                dbStatement
            );
        });

        // Validate Kafka messages sent by accounts-service.
        const kafkaSendMessageSpans2 = await testTraceManager.findSpans({
            service: 'accounts-service',
            operation: 'kafka.sendMessage',
            spanSelectors: { key: 'messaging.destination', value: 'emails' },
        });
        assert.ok(
            kafkaSendMessageSpans2?.length,
            'Operation kafka.sendMessage in service accounts-service did not occur'
        );
        validate(kafkaSendMessageSpans2, (span) => {
            const messagingPayload = {
                email: nonEmail,
                amount,
                balance: amount,
            };
            assert.deepEqual(
                JSON.parse(span.attributes['messaging.payload'] as string),
                messagingPayload
            );
        });

        // Validate Kafka messages received by emails-service.
        const kafkaEachMessageSpans2 = await testTraceManager.findSpans({
            service: 'emails-service',
            operation: 'kafka.eachMessage',
            spanSelectors: { key: 'messaging.destination', value: 'emails' },
        });
        assert.ok(
            kafkaEachMessageSpans2?.length,
            'Operation kafka.eachMessage in service emails-service did not occur'
        );

        // Validate SES email messages sent by emails-service.
        const sesSendSpans = await testTraceManager.findSpans({
            service: 'emails-service',
            operation: 'aws.ses.sendEmail',
            spanSelectors: {
                key: 'aws.ses.sender',
                value: 'demo@gethelios.dev',
            },
        });
        assert.ok(
            sesSendSpans?.length,
            'Operation aws.ses.sendEmail in service emails-service did not occur'
        );
    });

});
