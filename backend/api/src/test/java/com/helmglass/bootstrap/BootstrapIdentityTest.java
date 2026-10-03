package com.helmglass.bootstrap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.json.JsonMapper;

class BootstrapIdentityTest {
  @TempDir
  Path directory;

  @Test
  void migrationRequiresOnlyItsOwnIdentityAndDatabaseCredentials() throws Exception {
    Path file = directory.resolve("migration.json");
    Files.writeString(file, """
        {"schemaVersion":1,"vault":{"address":"https://vault:8200","caPem":"fixture",
        "roleId":"migration","secretId":"fixture"}}
        """);
    assertThat(BootstrapIdentity.read(file, true).tls()).isNull();
    assertThatThrownBy(() -> BootstrapIdentity.read(file, false))
        .isInstanceOf(IllegalArgumentException.class);
    RuntimeSecrets secrets = JsonMapper.builder().build().readValue("""
        {"databaseUrl":"jdbc:postgresql://postgres/helm","databaseUsername":"migration",
        "databasePassword":"fixture"}
        """, RuntimeSecrets.class);
    assertThat(secrets.properties(true)).hasSize(3);
    assertThatThrownBy(() -> secrets.properties(false)).isInstanceOf(IllegalArgumentException.class);
  }
}
