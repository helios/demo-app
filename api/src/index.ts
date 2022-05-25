import { initialize, createCustomSpan } from '@heliosphere/opentelemetry-sdk';

initialize({ apiToken: process.env.HS_TOKEN, serviceName: 'api-service', enable: true });

import { Controller, Get, HttpStatus, Module, Post, Req, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Request, Response } from 'express';
import axios from 'axios';
import cryptoRandomString from 'crypto-random-string';
import { Kafka, Producer } from 'kafkajs';
import AWS from 'aws-sdk';

const config = {
    region: 'us-east-1',
    endpoint: 'http://localstack:4566',
    credentials: new AWS.Credentials('test', 'test'),
};
const dynamodb = new AWS.DynamoDB(config);
const table = 'accounts';
const userServiceHost = process.env.USERS_SERVICE_HOST || 'localhost';
const kafkaBroker = process.env.KAFKA_BROKER || 'localhost:9093';
const kafka = new Kafka({ brokers: [kafkaBroker], clientId: `client-${Math.floor(Math.random() * 1000)}` });
const producer = kafka.producer();
const useHttps = process.env.USE_HTTPS === 'true';

interface Deposit {
    email: string,
    amount: number,
    currency: string
}

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
        // Ignore if table already exists
    }
};

class ApiService {
    private kafkaProducer: Producer;
    private clientId: string;

    constructor() {
        this.clientId = cryptoRandomString({ length: 10 });
        const kafka = new Kafka({ brokers: [kafkaBroker], clientId: this.clientId });
        this.kafkaProducer = kafka.producer();
        this.kafkaProducer.connect();
    }

    sendToKafka(booking: Deposit) {
        return this.kafkaProducer.send({ messages: [{ value: JSON.stringify(booking) }], topic: 'deposits' });
    }

    sendReportToKafka(payload: any) {
        return this.kafkaProducer.send({ messages: [{ value: payload }], topic: 'reports' });
    }

}

@Controller()
class ApplicationController {
    private readonly apiService: ApiService = new ApiService();

    @Get('health')
    health(@Req() _req: Request, @Res() res: Response): void {
        res.status(HttpStatus.OK).send('OK');
    }

    private async checkUserExistsByEmail(email: string) {
        const result = await this.getUserDetailsByEmail(email);
        return !!result;
    }

    private async getUserDetailsByEmail(email: string) {
        if (email) {
            const { data } = await axios.post(`http://${userServiceHost}:8081/users/by-email`, { email })
            return data.length > 0 ? data[0] : undefined;
        }
    }

    private async getUserDetailsById(id: number) {
        if (id) {
            const { data } = await axios.get(`http://${userServiceHost}:8081/users?id=${id}`)
            return data.length > 0 ? data[0] : undefined;
        }
    }

    @Post('users')
    async createUser(@Req() req: Request, @Res() res: Response): Promise<void> {
        const { email, name } = req.body;
        if (!email || !name) {
            res.status(HttpStatus.BAD_REQUEST).send('Missing email / name')
            return;
        }

        const userDetails = await this.getUserDetailsByEmail(email);
        if (userDetails) {
            res.status(200).send({ result: 'user already exists', id: userDetails.id })
            return;
        }

        const result = await axios.post(`http://${userServiceHost}:8081/users`, { email, name }, { headers: { 'content-type': 'application/json' } });
        res.status(200).send({ result: 'success', id: result.data.id })
    }

    @Get('users')
    async getUser(@Req() req: Request, @Res() res: Response): Promise<void> {
        const { id } = req.query;
        if (!id) {
            res.status(HttpStatus.BAD_REQUEST).send('Missing id query param')
            return;
        }

        const user = await this.getUserDetailsById(parseInt(id as string));
        res.status(200).send(user)
    }

    @Post('users/by-email')
    async getUserByEmail(@Req() req: Request, @Res() res: Response): Promise<void> {
        const { email } = req.body;
        if (!email) {
            res.status(HttpStatus.BAD_REQUEST).send('Missing email query param')
            return;
        }

        const user = await this.getUserDetailsByEmail(email as string);
        res.status(200).send(user)
    }

    @Get('users/:id/balance')
    async getUserBalancer(@Req() req: Request, @Res() res: Response): Promise<void> {
        const { id } = req.params;
        const user = await this.getUserDetailsById(parseInt(id as string));
        if (!user) {
            res.status(HttpStatus.NOT_FOUND).send('Could not find user details');
            return;
        }

        const response = await getItemFromDynamoDb(user.email)
        if (!response.Item) {
            res.status(200).send('Current balance: 0');
            return;
        }

        res.status(200).send(`Current balance: ${response.Item.amount.N}`)
    }

    @Post('deposit')
    async deposit(@Req() req: Request, @Res() res: Response) {
        const { email, amount, currency } = req.body;

        const userExists = await createCustomSpan('Validate user', { email }, async () => {
            return await this.checkUserExistsByEmail(email);
        });

        if (!userExists) {
            res.status(404).send('User could not be found');
            return;
        }

        const deposit = { email, amount, currency };
        createCustomSpan('Start deposit flow', { email, amount, currency }, async () => {
            try {
                await this.apiService.sendToKafka(deposit);
                res.status(HttpStatus.OK).send('OK');
            } catch (error) {
                res.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Failed: ' + error.message);
            }
        });
    }

    @Post("report")
    async report(@Req() req: Request, @Res() res: Response) {
        const { deposits, reportFormat } = req.body;
        const messagePayload = JSON.stringify({ deposits, reportFormat });

        try {
            await this.apiService.sendReportToKafka(messagePayload);
            res.status(HttpStatus.OK).send('OK');
        } catch (error) {
            res.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Failed: ' + error.message);
        }

        res.status(200).send("Reports triggered successfully");
    }
}

@Module({ controllers: [ApplicationController] })
class ApplicationModule { }

NestFactory.create(ApplicationModule).then((nestApplication) => {
    createDynamoDbTable();
    const port = 8080;
    nestApplication.listen(port);
    console.log(`Demo API application is listening on port ${port}.`);
});
