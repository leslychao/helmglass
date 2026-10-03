package com.helmglass.profile.domain;

import com.google.common.net.InetAddresses;
import com.google.common.net.InternetDomainName;
import com.helmglass.api.DomainException;
import java.net.URI;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Exact storage origins and RFC domain-match candidates bounded by the Public Suffix List. */
public final class ProfileScope {
  private ProfileScope() {}

  public static List<String> cookieDomains(List<String> admittedOrigins) {
    if (admittedOrigins.isEmpty() || admittedOrigins.size() > 64) {
      throw DomainException.conflict("PROFILE_SCOPE_INVALID", "Profile origin scope is unavailable");
    }
    Set<String> domains = new LinkedHashSet<>();
    for (String origin : admittedOrigins) {
      URI uri = URI.create(origin);
      String host = uri.getHost();
      if (host == null || uri.getUserInfo() != null
          || !(uri.getScheme().equals("https") || uri.getScheme().equals("http"))
          || !uri.getPath().isEmpty() || uri.getQuery() != null || uri.getFragment() != null) {
        throw DomainException.conflict("PROFILE_SCOPE_INVALID", "Profile contains a non-origin URL");
      }
      host = host.toLowerCase(Locale.ROOT);
      if (InetAddresses.isInetAddress(host)) {
        domains.add(host);
        continue;
      }
      InternetDomainName domain = InternetDomainName.from(host);
      if (domain.isPublicSuffix()) {
        throw DomainException.conflict("PROFILE_PUBLIC_SUFFIX", "A public suffix is not a profile scope");
      }
      domains.add(domain.toString());
      if (domain.isUnderPublicSuffix()) {
        while (!domain.isPublicSuffix()) {
          domains.add("." + domain);
          domain = domain.parent();
        }
      }
    }
    return List.copyOf(domains);
  }
}
