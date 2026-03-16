const { BlobServiceClient, StorageSharedKeyCredential, generateBlobSASQueryParameters, BlobSASPermissions } = require('@azure/storage-blob');

let blobServiceClient = null;

function getClient() {
  if (!blobServiceClient) {
    const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!connStr) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured');
    blobServiceClient = BlobServiceClient.fromConnectionString(connStr);
  }
  return blobServiceClient;
}

/**
 * Upload a file buffer to Azure Blob Storage.
 * @param {string} containerName
 * @param {string} blobName  - unique key, e.g. "uploads/userId/filename-timestamp.pdf"
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @returns {Promise<string>} blob URL (non-public; use generateSasUrl to download)
 */
async function uploadFile(containerName, blobName, buffer, mimeType) {
  const client = getClient();
  const containerClient = client.getContainerClient(containerName);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  await blockBlobClient.upload(buffer, buffer.length, {
    blobHTTPHeaders: { blobContentType: mimeType },
  });
  return blockBlobClient.url;
}

/**
 * Generate a time-limited SAS URL for a private blob.
 * @param {string} containerName
 * @param {string} blobName
 * @param {number} expiryMinutes  default 60
 * @returns {Promise<string>} SAS URL valid for expiryMinutes
 */
async function generateSasUrl(containerName, blobName, expiryMinutes = 60) {
  const client = getClient();

  // Parse account name and key from connection string
  const match = process.env.AZURE_STORAGE_CONNECTION_STRING.match(
    /AccountName=([^;]+);.*AccountKey=([^;]+)/
  );
  if (!match) throw new Error('Cannot parse storage account credentials from connection string');

  const accountName = match[1];
  const accountKey = match[2];
  const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);

  const expiresOn = new Date(Date.now() + expiryMinutes * 60 * 1000);
  const sasParams = generateBlobSASQueryParameters(
    {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse('r'),
      expiresOn,
    },
    sharedKeyCredential
  );

  const containerClient = client.getContainerClient(containerName);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  return `${blockBlobClient.url}?${sasParams.toString()}`;
}

/**
 * Delete a blob.
 */
async function deleteBlob(containerName, blobName) {
  const client = getClient();
  const containerClient = client.getContainerClient(containerName);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  await blockBlobClient.deleteIfExists();
}

/**
 * List blobs with an optional prefix.
 * @returns {Promise<Array<{name, size, lastModified}>>}
 */
async function listBlobs(containerName, prefix = '') {
  const client = getClient();
  const containerClient = client.getContainerClient(containerName);
  const results = [];
  for await (const blob of containerClient.listBlobsFlat({ prefix })) {
    results.push({
      name: blob.name,
      size: blob.properties.contentLength,
      lastModified: blob.properties.lastModified,
    });
  }
  return results;
}

module.exports = { uploadFile, generateSasUrl, deleteBlob, listBlobs };
