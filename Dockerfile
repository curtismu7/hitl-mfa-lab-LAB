# Build the web app, then run the API server, which also serves web/dist. Same pattern as the other demos.
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY server/package.json server/
RUN npm ci
COPY web web
RUN npm run build -w web

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=7680 MODE=mock
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY server/package.json server/
RUN npm ci --omit=dev -w server && npm cache clean --force
COPY server/src server/src
COPY server/diagrams server/diagrams
COPY --from=build /app/web/dist web/dist
USER node
EXPOSE 7680
# Inside the container the server must listen on all interfaces, so HMLAB_BIND is set here on purpose.
# The compose file publishes the port on 127.0.0.1 only; do not publish it more widely.
ENV HMLAB_BIND=0.0.0.0
CMD ["node", "server/src/index.js"]
