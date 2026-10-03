package com.helmglass.browser.infrastructure.repository;

import jakarta.annotation.PreDestroy;
import java.sql.Connection;
import java.sql.SQLException;
import javax.sql.DataSource;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Repository;

@Slf4j
@Repository
public class SchedulerLeadership {
  private static final long LOCK_ID = 72409928650319L;
  private final DataSource dataSource;
  private Connection connection;

  public SchedulerLeadership(DataSource dataSource) {
    this.dataSource = dataSource;
  }

  public synchronized boolean acquired() {
    try {
      if (connection != null && connection.isValid(1)) {
        return true;
      }
      close();
      Connection candidate = dataSource.getConnection();
      try (var query = candidate.prepareStatement("SELECT pg_try_advisory_lock(?)")) {
        query.setLong(1, LOCK_ID);
        try (var result = query.executeQuery()) {
          if (result.next() && result.getBoolean(1)) {
            connection = candidate;
            return true;
          }
        }
      } catch (SQLException error) {
        candidate.close();
        throw error;
      }
      candidate.close();
      return false;
    } catch (SQLException error) {
      close();
      log.warn("Dispatch leadership is unavailable; errorType={}", error.getClass().getSimpleName());
      return false;
    }
  }

  @PreDestroy
  public synchronized void close() {
    if (connection != null) {
      try {
        try (var query = connection.prepareStatement("SELECT pg_advisory_unlock(?)")) {
          query.setLong(1, LOCK_ID);
          query.execute();
        }
      } catch (SQLException error) {
        log.debug("Leadership connection already unavailable");
      } finally {
        try {
          connection.close();
        } catch (SQLException error) {
          log.debug("Leadership connection close failed");
        }
        connection = null;
      }
    }
  }
}
