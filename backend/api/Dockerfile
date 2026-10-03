FROM maven:3.9.16-eclipse-temurin-25@sha256:93b8a14ea2f412782e4e842651273b4d903e35cc496284f178fbbe2d67d00976 AS build
WORKDIR /workspace
COPY pom.xml ./pom.xml
COPY api/pom.xml ./api/pom.xml
COPY .mvn ./.mvn
COPY --chmod=755 mvnw ./mvnw
RUN --mount=type=cache,target=/root/.m2,sharing=locked ./mvnw -B -ntp -pl api dependency:go-offline
COPY api/src ./api/src
COPY worker-protocol/schemas ./worker-protocol/schemas
RUN --mount=type=cache,target=/root/.m2,sharing=locked ./mvnw -B -ntp -pl api package -DskipTests
FROM eclipse-temurin:25-jre@sha256:fcd7fd7b387f94bb2ac461478a7436ad8e349924c374ea8313919624dceae636
RUN groupadd --gid 10001 helm && useradd --uid 10001 --gid helm --no-create-home helm
WORKDIR /app
COPY --from=build /workspace/api/target/api-1.0.0-SNAPSHOT.jar /app/api.jar
COPY --chmod=755 api/bin/healthcheck /opt/helm/bin/healthcheck
USER 10001:10001
EXPOSE 8080 8444 8446
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=70", "-XX:-HeapDumpOnOutOfMemoryError", "-jar", "/app/api.jar"]
