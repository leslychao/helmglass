<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Helm Glass — вход</title>
  <#-- Keycloak keeps the resource URL across custom theme updates and caches CSS for 30 days. -->
  <link rel="stylesheet" href="${url.resourcesPath}/css/helmglass.css?v=20261008">
</head>
<body>
  <main class="auth-layout">
    <section class="auth-product" aria-label="Helm Glass">
      <a class="brand" href="${url.loginUrl}"><img src="/helm-logo.png" alt="" width="42" height="42">Helm Glass</a>
      <div class="product-copy">
        <h1>Задайте цель.<br>Следите за результатом.</h1>
        <p>Задачи, сайты и история в личном кабинете. ChatGPT управляет выполнением через MCP.</p>
      </div><small>Helm Glass Service · Задачи в браузере из ChatGPT</small>
    </section>
    <section class="auth-form-side">
      <div class="auth-form">
        <a class="brand mobile-brand" href="${url.loginUrl}"><img src="/helm-logo.png" alt="" width="42" height="42">Helm Glass</a>
        <h2><#nested "header"></h2>
        <p class="form-intro">Продолжите работу в своём кабинете.</p>
        <#if displayMessage && message?has_content && !messagesPerField.existsError('username','password')>
          <div class="message ${message.type}" role="alert">${kcSanitize(message.summary)?no_esc}</div>
        </#if>
        <#nested "form">
        <#nested "socialProviders">
        <#if displayInfo><div class="form-info"><#nested "info"></div></#if>
      </div>
    </section>
  </main>
</body>
</html>
</#macro>
