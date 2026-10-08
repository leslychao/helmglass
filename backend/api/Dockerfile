FROM node:24.17.0-bookworm-slim AS widget
WORKDIR /widget
COPY widget/package*.json ./
RUN npm ci --no-audit --no-fund
COPY widget/ ./
RUN npm run build

FROM maven:3.9-eclipse-temurin-21@sha256:99e61abcff91a9b1333463bd8451fb18495d6eba9250ac66a338b518f8278320 AS build
WORKDIR /workspace
COPY pom.xml ./
RUN mvn -B -ntp dependency:go-offline
COPY src ./src
COPY --from=widget /src/main/resources/mcp-widget ./src/main/resources/mcp-widget
RUN mvn -B -ntp package

FROM eclipse-temurin:21-jre@sha256:cff19e6215689161eb6162c11b86b0c60ddf802164f2eaf48d570f8fb79a36c5
WORKDIR /app
RUN mkdir -p /data/artifacts && chown -R 10001:10001 /app /data
COPY --from=build /workspace/target/helmglass-api-1.0.0.jar /app/app.jar
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
