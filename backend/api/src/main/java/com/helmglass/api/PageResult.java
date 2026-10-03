package com.helmglass.api;

import java.util.List;
import java.util.Map;

public record PageResult<T>(List<T> items, long total, int page, int pageSize,
    Map<String, String> sort, String snapshot) {}
