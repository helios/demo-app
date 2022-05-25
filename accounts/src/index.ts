import initialize from '@heliosphere/opentelemetry-sdk';
import { propagation, context } from '@opentelemetry/api';
initialize({ apiToken: process.env.HS_TOKEN, serviceName: 'accounts-service', enable: true });

import Stripe from 'stripe';
import { EachMessagePayload, Kafka } from 'kafkajs';
import AWS from 'aws-sdk';
import axios from 'axios';
import winston from 'winston';

const financialServiceHost = process.env.FINANCIAL_SERVICE_HOST || 'localhost';
const broker = process.env.KAFKA_BROKER || 'localhost:9093';
const kafka = new Kafka({ brokers: [broker], clientId: `client-${Math.floor(Math.random() * 1000)}` });
const groupId = `group-${Math.floor(Math.random() * 1000)}`;
const consumer = kafka.consumer({ groupId, maxWaitTimeInMs: 100 });
const producer = kafka.producer();

const stripe = new Stripe('sk_test_4eC39HqLyjWDarjtT1zdp7dc', { apiVersion: '2020-08-27' });
const config = {
    region: 'us-east-1',
    endpoint: 'http://localstack:4566',
    credentials: new AWS.Credentials('test', 'test'),
};
const dynamodb = new AWS.DynamoDB(config);
const table = 'accounts';

const createLogger = () => {
    return winston.createLogger({
        format: winston.format.combine(winston.format.errors({ stack: true }), winston.format.simple()),
        transports: [new winston.transports.Console()],
    });
};

const logger = createLogger();

const createDynamoDbTable = async () => {
    const params = {
        TableName: table,
        AttributeDefinitions: [
            { AttributeName: 'email', AttributeType: 'S' },
        ],
        KeySchema: [
            { AttributeName: 'email', KeyType: 'HASH' },
        ],
        ProvisionedThroughput: {
            ReadCapacityUnits: 1,
            WriteCapacityUnits: 1,
        },
        StreamSpecification: {
            StreamEnabled: false,
        },
    };

    try {
        await dynamodb.createTable(params).promise();
    } catch (error) {
        if (error.message !== 'Table already created') throw error;
    }
};

const getItemFromDynamoDb = async (email: string) => {
    return await dynamodb
        .getItem({
            TableName: table,
            Key: {
                email: { S: email },
            },
        })
        .promise();
};

const putItemInDynamoDb = async (email: string, amount: number) => {
    return await dynamodb
        .putItem({
            TableName: table,
            Item: {
                email: { S: email },
                amount: { N: amount.toString() },
            },
        })
        .promise();
};

const updateItemInDynamoDb = async (email: string, amount: number) => {
    await dynamodb
        .updateItem({
            TableName: 'accounts',
            Key: {
                email: { S: email },
            },
            UpdateExpression: 'set amount = :amount',
            ExpressionAttributeValues: {
                ':amount': { N: amount.toString() },
            },
        })
        .promise();
};

const getUserDetails = async (email: string) => {
    return await getItemFromDynamoDb(email);
}

const updateUserDetails = async (email: string, amount: number) => {
    const item = await getUserDetails(email);
    if (item?.Item) {
        const currentBalance = parseInt(item.Item.amount.N);
        await updateItemInDynamoDb(email, currentBalance + amount)
        return currentBalance + amount
    } else {
        await putItemInDynamoDb(email, amount);
        return amount;
    }
};

const getDollarAmount = async (amount: string, currency: string) => {
    const result = await axios.get(`http://${financialServiceHost}:8082/exchange_rate?amount=${amount}&currency=${currency}`);
    return result.data.usdAmount as number;
}

(async () => {
    await createDynamoDbTable();
    await consumer.subscribe({ fromBeginning: false, topic: 'deposits' });
    await consumer.subscribe({ fromBeginning: false, topic: 'reports' });
    await consumer.connect();
    await producer.connect();
    await consumer.run({
        eachMessage: async (eachMessagePayload: EachMessagePayload): Promise<void> => {
            try {
                logger.error('Received message: ' + JSON.stringify(eachMessagePayload));
                if (eachMessagePayload.topic === 'deposits') {
                    const message = JSON.parse(eachMessagePayload.message.value.toString());
                    const { amount, currency, email } = message;
                    const dollarAmount = await getDollarAmount(amount, currency);
                    await stripe.paymentIntents.create({ amount: Math.round(amount*100), currency });
                    const balance = await updateUserDetails(email, dollarAmount);
                    await producer.send({ messages: [{ value: JSON.stringify({ email, amount, balance }) }], topic: 'emails' });
                }
            } catch (error) {
                console.log(error);
            }
        },
    });
})();
