package com.helmglass.task.infrastructure.repository;

import com.helmglass.task.domain.TaskAggregate;
import jakarta.persistence.LockModeType;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface JpaTaskRepository extends JpaRepository<TaskAggregate, UUID> {
  Optional<TaskAggregate> findByIdAndUserId(UUID id, UUID userId);

  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query("select t from TaskAggregate t where t.id = :id and t.userId = :user")
  Optional<TaskAggregate> lockOwned(@Param("id") UUID id, @Param("user") UUID userId);
}
