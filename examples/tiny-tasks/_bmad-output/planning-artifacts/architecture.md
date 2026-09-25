# Architecture: Tiny Tasks

## Stack

- Mobile: Expo (React Native), also runs on the web
- API: Node.js with Fastify
- Database: Postgres
- Hosting: API on Azure App Service, database on Azure Database for PostgreSQL

## Decisions

- Session tokens are JWTs stored in secure storage on the device
- Tasks sync through the API; the app keeps an offline cache
