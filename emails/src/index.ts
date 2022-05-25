import initialize from '@heliosphere/opentelemetry-sdk';
initialize({ apiToken: process.env.HS_TOKEN, serviceName: 'emails-service', enable: true });
import { EachMessagePayload, Kafka } from 'kafkajs';
import AWS from 'aws-sdk';

const broker = process.env.KAFKA_BROKER || 'localhost:9093';
const kafka = new Kafka({ brokers: [broker], clientId: `client-${Math.floor(Math.random() * 1000)}` });
const groupId = `group-${Math.floor(Math.random() * 1000)}`;
const consumer = kafka.consumer({ groupId, maxWaitTimeInMs: 100 });
const config = {
    region: 'us-east-1',
    endpoint: 'http://localstack:4566',
    credentials: new AWS.Credentials('test', 'test'),
};
const ses = new AWS.SES(config);
const senderEmail = 'demo@gethelios.dev';

const sendSesEmail = async (recipients: string[], subject: string, body: string) => {
    var params = {
        Destination: {
            ToAddresses: recipients,
        },
        Message: {
            Body: {
                Text: {
                    Charset: 'UTF-8',
                    Data: body,
                },
            },
            Subject: {
                Charset: 'UTF-8',
                Data: subject,
            },
        },
        Source: senderEmail,
    };

    return ses.sendEmail(params).promise();
};

(async () => {
    await ses.verifyEmailIdentity({ EmailAddress: senderEmail }).promise();
    await consumer.subscribe({ fromBeginning: false, topic: 'emails' });
    await consumer.connect();
    await consumer.run({
        eachMessage: async (eachMessagePayload: EachMessagePayload): Promise<void> => {
            try {
                const message = JSON.parse(eachMessagePayload.message.value.toString());
                const { email, amount, balance } = message;
                if (email?.indexOf('@') <= 0) {
                    console.error(`recipient is not a valid email ${email}`);
                    return;
                }
                await sendSesEmail([email], 'A deposit has been made to your account', `You have received ${amount} dollars, your current balance is ${balance}`)
            } catch (error) {
                console.log(error);
                throw(error);
            }
        },
    });
})();
