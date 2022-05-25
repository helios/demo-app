FROM node:15.12.0-slim
RUN npm -g install typescript@4.3.5

USER node
RUN mkdir -p /home/node/helios-demo-app/users
WORKDIR /home/node/helios-demo-app/users
COPY --chown=node:node package.json package-lock.json tsconfig.json ./
COPY --chown=node:node src ./src/
RUN npm install
RUN npm list
RUN tsc

CMD ["node", "dist/src/index.js"]
