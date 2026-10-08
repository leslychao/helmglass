<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false; section>
  <#if section = "header">Не удалось войти
  <#elseif section = "form">
    <div class="message error" role="alert">${kcSanitize(message.summary)?no_esc}</div>
    <a class="button" href="${url.loginUrl}">Вернуться ко входу</a>
  </#if>
</@layout.registrationLayout>
