FROM node:22-alpine
WORKDIR /app
COPY contract.js server.js ./
USER node
EXPOSE 8081
CMD ["node", "server.js"]
