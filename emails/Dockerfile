FROM node:15.12.0-slim
RUN npm -g install typescript

USER node
RUN mkdir -p /home/node/helios-demo-app/emails-service
WORKDIR /home/node/helios-demo-app/emails-service
COPY --chown=node:node package.json package-lock.json tsconfig.json ./
COPY --chown=node:node src ./src/
RUN npm install
RUN tsc

CMD ["node", "dist/src/index.js"]
