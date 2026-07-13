package main

// Indirections keep device enrollment tests independent from the host keyring.
var deviceKeyStore = storePlatformCredential
var deviceKeyLoad = loadPlatformCredential
var deviceKeyDelete = deletePlatformCredential
