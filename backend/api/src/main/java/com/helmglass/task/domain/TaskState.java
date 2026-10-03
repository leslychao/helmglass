package com.helmglass.task.domain;

public enum TaskState {
  DRAFT, WAITING_AGENT, QUEUED, STARTING, RUNNING, PAUSING, PAUSED, WAITING_USER,
  STOPPING, COMPLETED, FAILED, CANCELLED, INTERRUPTED;

  public boolean terminal() {
    return this == COMPLETED || this == FAILED || this == CANCELLED;
  }
}
