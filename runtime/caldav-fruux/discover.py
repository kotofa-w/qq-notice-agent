"""Read-only fruux CalDAV discovery. Credentials arrive through standard input."""

import base64
import json
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from xml.etree import ElementTree as ET


BASE_URL = "https://dav.fruux.com/"
D = "{DAV:}"
C = "{urn:ietf:params:xml:ns:caldav}"


def fruux_url(base, href):
    url = urljoin(base, href)
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname != "dav.fruux.com" or parsed.port not in (None, 443) or parsed.username or parsed.password:
        raise ValueError("Discovery returned an unexpected server; credentials were not forwarded.")
    return url


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_):
        return None


def main():
    credentials = json.load(sys.stdin)
    authorization = "Basic " + base64.b64encode(
        (credentials["username"] + ":" + credentials["password"]).encode("utf-8")
    ).decode()
    opener = build_opener(NoRedirect())

    def propfind(url, properties, depth):
        body = (f'<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
                f'<d:prop>{properties}</d:prop></d:propfind>').encode()
        for _ in range(4):
            req = Request(url, data=body, method="PROPFIND", headers={
                "Authorization": authorization, "Depth": str(depth),
                "Content-Type": "application/xml; charset=utf-8",
            })
            try:
                response = opener.open(req, timeout=25)
            except HTTPError as error:
                response = error
            with response:
                if response.status in (301, 302, 307, 308):
                    url = fruux_url(url, response.headers["Location"])
                    continue
                if response.status != 207:
                    raise RuntimeError(f"CalDAV discovery returned HTTP {response.status}.")
                raw = response.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    raise RuntimeError("Discovery response is too large.")
                root = ET.fromstring(raw)
                items = []
                for item in root.findall(D + "response"):
                    href = item.findtext(D + "href")
                    properties = {}
                    for part in item.findall(D + "propstat"):
                        if " 200 " in (part.findtext(D + "status") or ""):
                            prop = part.find(D + "prop")
                            if prop is not None:
                                properties.update({child.tag: child for child in prop})
                    if href:
                        items.append((fruux_url(url, href), properties))
                return items
        raise RuntimeError("Too many discovery redirects.")

    def property_href(items, name):
        for url, properties in items:
            prop = properties.get(name)
            if prop is not None:
                href = prop.findtext(D + "href")
                if href:
                    return fruux_url(url, href)
        raise RuntimeError("Required CalDAV discovery property is missing.")

    principal = property_href(propfind(BASE_URL, "<d:current-user-principal/>", 0), D + "current-user-principal")
    home = property_href(propfind(principal, "<c:calendar-home-set/>", 0), C + "calendar-home-set")
    props = ("<d:resourcetype/><d:displayname/><c:supported-calendar-component-set/>"
             "<d:current-user-privilege-set/>")
    calendars = []
    for url, properties in propfind(home, props, 1):
        resource = properties.get(D + "resourcetype")
        if resource is None or resource.find(C + "calendar") is None:
            continue
        component = properties.get(C + "supported-calendar-component-set")
        if component is not None and not any(item.get("name") == "VEVENT" for item in component):
            continue
        privilege_set = properties.get(D + "current-user-privilege-set")
        privileges = set()
        if privilege_set is not None:
            privileges = {child.tag for item in privilege_set.findall(D + "privilege") for child in item}
        title = properties.get(D + "displayname")
        calendars.append({"url": url, "name": title.text if title is not None else None,
                          "canCreateEvent": bool(privileges & {D + "bind", D + "write", D + "all"}) if privilege_set is not None else None})
    result = {"baseUrl": BASE_URL, "principalUrl": principal, "calendarHomeUrl": home,
              "calendars": calendars, "readOnlyDiscovery": True}
    destination = Path(__file__).parent / "private" / "discovery.json"
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"discoveryPassed": True, "calendarCount": len(calendars),
                      "writableCalendarCount": sum(item["canCreateEvent"] is True for item in calendars)}))


if __name__ == "__main__":
    main()
