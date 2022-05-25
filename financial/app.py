from flask import Flask
from flask import request
from helios import initialize

# Not necessary since we're initializing with env vars
# hs = initialize(api_token = process.env.HS_TOKEN, service_name = 'financial-service', enabled = True)

app = Flask(__name__)

currency_exchange = {
    'USD': 1.0,
    'EUR': 0.83,
    'JPY': 108.92,
    'GBP': 0.72,
    'ILS': 3.25,
};

@app.route('/exchange_rate', methods=['GET'])
def exchange_rates():
    app.logger.info(f"Received currency exchange request: {request.args}");

    currency = request.args["currency"];
    exchangeRate = currency_exchange.get(currency);

    if (exchangeRate):
        return { "exchangeRate": exchangeRate, "usdAmount": (float(request.args["amount"]) / exchangeRate) };
    else:
        return { "statusText": f"Invalid currency {currency}." }, 400;


if __name__ == '__main__':
    app.run()
