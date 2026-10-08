package ru.helmglass.api;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.UUID;

public final class Database {
  private Database() {}

  public static UUID uuid(ResultSet row, String column) throws SQLException {
    return row.getObject(column, UUID.class);
  }

  public static Instant instant(ResultSet row, String column) throws SQLException {
    var value = row.getTimestamp(column);
    return value == null ? null : value.toInstant();
  }
}
