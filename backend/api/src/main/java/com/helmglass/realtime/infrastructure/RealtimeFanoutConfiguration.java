package com.helmglass.realtime.infrastructure;

import com.helmglass.realtime.application.RealtimeDeliveryService;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

/** Redis transports invalidations; disconnected clients recover through the existing snapshot. */
@Configuration(proxyBeanMethods = false)
public class RealtimeFanoutConfiguration {
  @Bean
  ThreadPoolTaskExecutor realtimeFanoutExecutor(RealtimeDeliveryService realtime) {
    var executor = new ThreadPoolTaskExecutor();
    executor.setThreadNamePrefix("realtime-fanout-");
    executor.setCorePoolSize(2);
    executor.setMaxPoolSize(2);
    executor.setQueueCapacity(256);
    executor.setRejectedExecutionHandler((task, pool) -> realtime.resynchronizeClients());
    return executor;
  }

  @Bean
  RedisMessageListenerContainer realtimeFanout(
      RedisConnectionFactory connections,
      RealtimeDeliveryService realtime,
      @Qualifier("realtimeFanoutExecutor") ThreadPoolTaskExecutor executor) {
    var container = new RedisMessageListenerContainer();
    container.setConnectionFactory(connections);
    container.setTaskExecutor(executor);
    container.setErrorHandler(error -> realtime.fanoutUnavailable());
    container.addMessageListener(
        realtime, new ChannelTopic(RealtimeDeliveryService.FANOUT_CHANNEL));
    return container;
  }
}
