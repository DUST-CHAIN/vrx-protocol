<?php
/**
 * Vetted Realty — contact form handler (Hetzner shared hosting, PHP mail()).
 * Ships alongside the static site. The static index.astro form POSTs here.
 *
 * Hardening: honeypot field, basic validation, header-injection guard, redirect-back on done.
 */

$to      = 'vrx@vettedrealty.com';
$site    = 'vettedrealty.com';

// Redirect back to the page the form was submitted FROM (works at any deploy path, incl. /vrx).
// Only accept a same-host referer; fall back to the local index if absent/foreign.
$backUrl = 'index.html#contact';
if (!empty($_SERVER['HTTP_REFERER'])) {
    $ref  = $_SERVER['HTTP_REFERER'];
    $host = $_SERVER['HTTP_HOST'] ?? '';
    $p    = parse_url($ref);
    if (($p['host'] ?? '') === $host) {
        // strip any existing query/hash, keep scheme+host+path
        $backUrl = $p['scheme'] . '://' . $p['host'] . ($p['path'] ?? '/') . '#contact';
    }
}
// separator for our status flag (?sent / ?err) — go before the #hash
function back($base, $flag = '') {
    if ($flag === '') return $base;
    $hashPos = strpos($base, '#');
    $path = $hashPos === false ? $base : substr($base, 0, $hashPos);
    $hash = $hashPos === false ? '' : substr($base, $hashPos);
    $sep  = strpos($path, '?') === false ? '?' : '&';
    return $path . $sep . $flag . $hash;
}

function clean($v, $max = 2000) {
    $v = trim((string) $v);
    $v = substr($v, 0, $max);
    // strip anything that could be used for header injection
    return str_replace(["\r", "\n", "%0a", "%0d"], ' ', $v);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Location: ' . back($backUrl));
    exit;
}

// Honeypot: real users leave "website" blank. Bots fill it.
if (!empty($_POST['website'])) {
    header('Location: ' . back($backUrl, 'sent=1')); // pretend success, drop silently
    exit;
}

$name    = clean($_POST['name']    ?? '', 200);
$email   = clean($_POST['email']   ?? '', 200);
$role    = clean($_POST['role']    ?? '', 100);
$message = clean($_POST['message'] ?? '', 4000);

if ($name === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    header('Location: ' . back($backUrl, 'err=1'));
    exit;
}

$subject = "VRX enquiry — {$role} — {$name}";
$body    = "New enquiry from {$site}\n\n"
         . "Name:  {$name}\n"
         . "Email: {$email}\n"
         . "Role:  {$role}\n\n"
         . "Message:\n{$message}\n";

$headers  = "From: Vetted Realty <vrx@{$site}>\r\n";
$headers .= "Reply-To: {$name} <{$email}>\r\n";
$headers .= "Content-Type: text/plain; charset=UTF-8\r\n";

@mail($to, $subject, $body, $headers);

header('Location: ' . back($backUrl, 'sent=1'));
exit;
