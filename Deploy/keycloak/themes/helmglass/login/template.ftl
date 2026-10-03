<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<!DOCTYPE html>
<html lang="${lang}"<#if realm.internationalizationEnabled> dir="${(locale.rtl)?then('rtl','ltr')}"</#if>>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Helm Glass</title>
    <link rel="icon" href="${url.resourcesPath}/img/helm-logo.png">
    <link rel="stylesheet" href="${url.resourcesPath}/css/helm.css">
    <script type="importmap">
        {"imports":{"rfc4648":"${url.resourcesCommonPath}/vendor/rfc4648/rfc4648.js"}}
    </script>
    <#if scripts??>
        <#list scripts as script><script src="${script}"></script></#list>
    </#if>
    <#-- Retain Keycloak's cross-tab and expired authentication-session handling. -->
    <script type="module">
        <#outputformat "JavaScript">
        import { startSessionPolling, checkAuthSession } from ${(url.resourcesPath + "/js/authChecker.js")?c};
        startSessionPolling(${url.ssoLoginInOtherTabsUrl?c});
        <#if authenticationSession??>
        checkAuthSession(${authenticationSession.authSessionIdHash?c});
        </#if>
        </#outputformat>
    </script>
</head>
<body data-page-id="login-${pageId}" class="${bodyClass}">
<main class="auth-page">
    <section class="auth-art" aria-label="Helm Glass">
        <a class="brand" href="/sign-in"><img src="${url.resourcesPath}/img/helm-logo.png" width="42" height="42" alt=""><strong>Helm Glass</strong></a>
        <div class="auth-story">
            <h2>${msg("helmStoryTitle")}<br>${msg("helmStorySubtitle")}</h2>
            <p>${msg("helmStoryDescription")}</p>
        </div>
    </section>
    <section class="auth-form-side" aria-labelledby="kc-page-title">
        <div class="auth-card">
            <h1 id="kc-page-title"><#nested "header"></h1>
            <#if pageId == "login"><p class="description">${msg("helmLoginDescription")}</p></#if>
            <#if displayRequiredFields><p class="description">* ${msg("requiredFields")}</p></#if>
            <#if auth?has_content && auth.showUsername() && !auth.showResetCredentials()>
                <#nested "show-username">
                <p id="kc-username"><span id="kc-attempted-username">${auth.attemptedUsername}</span>
                    <a id="reset-login" href="${url.loginRestartFlowUrl}">${msg("restartLoginTooltip")}</a></p>
            </#if>
            <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
                <div class="notice ${message.type}" role="alert">${kcSanitize(message.summary)?no_esc}</div>
            </#if>
            <#-- The inherited forms own credentials, errors, MFA and required actions. -->
            <#nested "form">
            <#if auth?has_content && auth.showTryAnotherWayLink()>
                <form action="${url.loginAction}" method="post">
                    <input type="hidden" name="tryAnotherWay" value="on">
                    <button class="secondary" type="submit">${msg("doTryAnotherWay")}</button>
                </form>
            </#if>
            <#if switchOrganizationEnabled?? && switchOrganizationEnabled>
                <form action="${url.loginAction}" method="post">
                    <input type="hidden" name="switchOrganization" value="true">
                    <button class="secondary" type="submit">${msg("doSwitchOrganization")}</button>
                </form>
            </#if>
            <#nested "socialProviders">
            <#if displayInfo><div id="kc-info"><#nested "info"></div></#if>
        </div>
    </section>
</main>
</body>
</html>
</#macro>
