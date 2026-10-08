<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Helm Glass — вход</title>
  <link rel="stylesheet" href="${url.resourcesPath}/css/helmglass.css">
</head>
<body>
  <main class="auth-layout">
    <section class="auth-product" aria-label="Helm Glass">
      <a class="brand" href="${url.loginUrl}"><span class="brand-mark">H</span>Helm Glass</a>
      <div class="product-copy"><div class="eyebrow">ВАШ БРАУЗЕР ДЛЯ CHATGPT</div>
        <h1>Задайте цель.<br>Наблюдайте за работой.</h1>
        <p>ChatGPT выбирает шаги, Helm выполняет их в браузере. Вы видите ход работы и подключаетесь, когда нужно ваше участие.</p>
        <div class="product-features"><span>Один браузер задачи</span><span>Защищённый вход</span><span>Результаты с источниками</span></div>
      </div><small>Helm Glass · Управление остаётся у вас</small>
    </section>
    <section class="auth-form-side">
      <div class="auth-form">
        <a class="brand mobile-brand" href="${url.loginUrl}"><span class="brand-mark">H</span>Helm Glass</a>
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
