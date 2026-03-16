export async function closeServer(server: { close: (callback?: (err?: Error) => void) => void } | null | undefined): Promise<void> {
  if (!server) return

  if (server.close.length < 1) {
    server.close()
    return
  }

  await new Promise<void>((resolve, reject) => {
    server.close((err?: Error) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}
