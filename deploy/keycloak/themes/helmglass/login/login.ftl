<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=true displayInfo=false; section>
  <#if section = "header">Войти в Helm Glass
  <#elseif section = "form">
    <form id="kc-form-login" action="${url.loginAction}" method="post">
      <div class="field">
        <label for="username">Имя пользователя или email</label>
        <input id="username" name="username" value="${(login.username!'')}" type="text" autofocus autocomplete="username" required aria-invalid="${messagesPerField.existsError('username','password')?c}">
      </div>
      <div class="field">
        <label for="password">Пароль</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required aria-invalid="${messagesPerField.existsError('username','password')?c}">
      </div>
      <#if messagesPerField.existsError('username','password')>
        <p class="field-error" role="alert">${kcSanitize(messagesPerField.getFirstError('username','password'))?no_esc}</p>
      </#if>
      <#if realm.rememberMe>
        <label class="remember"><input name="rememberMe" type="checkbox" <#if login.rememberMe??>checked</#if>> Запомнить вход</label>
      </#if>
      <input type="hidden" name="credentialId" <#if auth.selectedCredential?has_content>value="${auth.selectedCredential}"</#if>>
      <button id="kc-login" name="login" type="submit">Войти</button>
    </form>
  </#if>
</@layout.registrationLayout>
