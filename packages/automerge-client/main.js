import Automerge, { DocSet } from 'automerge'

// Returns true if all components of clock1 are less than or equal to those of clock2.
// Returns false if there is at least one component in which clock1 is greater than clock2
// (that is, either clock1 is overall greater than clock2, or the clocks are incomparable).
function lessOrEqual(doc1, doc2) {
  const clock1 = doc1._state.getIn(['opSet', 'clock'])
  const clock2 = doc2._state.getIn(['opSet', 'clock'])
  return clock1
    .keySeq()
    .concat(clock2.keySeq())
    .reduce(
      (result, key) => result && clock1.get(key, 0) <= clock2.get(key, 0),
      true,
    )
}

function unique(el, i, list) {
  return list.indexOf(el) === i
}

function doSave(docs) {
  const ret = {}
  for (const [k, v] of Object.entries(docs)) {
    ret[k] = Automerge.save(v)
  }
  return JSON.stringify(ret)
}

function doLoad(string) {
  if (!string) return {}
  const docs = JSON.parse(string)
  const ret = {}
  for (const [k, v] of Object.entries(docs)) {
    ret[k] = Automerge.load(v)
  }
  return ret
}

export default class AutomergeClient extends EventTarget {
  constructor({ socket, save, savedData, onChange } = {}) {
    super()
    if (!socket)
      throw new Error('You have to specify websocket as socket param')
    if (!savedData)
      savedData = {}

    this.socket = socket
    this.save = save
    this.docs = typeof savedData === 'string' ? doLoad(savedData) : savedData
    this.onChange = onChange || (() => {})
    this.subscribeList = []

    socket.addEventListener('message', this.private_onMessage.bind(this))
    socket.addEventListener('open', this.private_onOpen.bind(this))
    socket.addEventListener('close', this.private_onClose.bind(this))
    socket.addEventListener('error', evt => console.log('error', evt))
    socket.addEventListener('connecting', evt => console.info('connecting', evt))
  }

  private_onMessage(msg) {
    const frame = JSON.parse(msg.data)

    if (frame.action === 'automerge') {
      this.autocon.receiveMsg(frame.data)
      this.dispatchEvent(new CustomEvent('automerge', {
        detail: {
          data: frame.data
        }
      }))
    } else if (frame.action === 'error') {
      console.error('Recieved server-side error ' + frame.message)
      this.dispatchEvent(new CustomEvent('error', {
        detail: {
          message: frame.message,
        }
      }))
    } else if (frame.action === 'subscribed') {
      console.info('Subscribed to ' + JSON.stringify(frame.id))
      this.dispatchEvent(new CustomEvent('subscribed', {
        detail: {
          id: frame.id,
        }
      }))
    } else {
      console.error('Unknown action "' + frame.action + '"')
    }
  }

  private_onOpen() {
    console.info('open')
    const send = data => {
      this.socket.send(JSON.stringify({ action: 'automerge', data }))
    }

    const docSet = (this.docSet = new DocSet())
    docSet.registerHandler((docId, doc) => {
      if (!this.docs[docId] || lessOrEqual(this.docs[docId], doc)) {
        // local changes are reflected in new doc
        this.docs[docId] = doc
      } else {
        // local changes are NOT reflected in new doc
        const merged = Automerge.merge(this.docs[docId], doc)
        setTimeout(() => docSet.setDoc(docId, merged), 0)
      }
      this.subscribeList = this.subscribeList.filter(el => el !== docId)

      if (this.save) {
        this.save(doSave(this.docs))
      }

      this.onChange(docId, this.docs[docId])
    })

    const autocon = (this.autocon = new Automerge.Connection(docSet, send))
    autocon.open()
    this.subscribe(Object.keys(this.docs).concat(this.subscribeList))
  }

  private_onClose() {
    console.info('close')
    if (this.autocon) {
      this.autocon.close()
    }

    this.docSet = null
    this.autocon = null
  }

  change(id, changer) {
    if (!(id in this.docs)) {
      return false
    }
    this.docs[id] = Automerge.change(this.docs[id], changer)
    if (this.docSet) {
      this.docSet.setDoc(id, this.docs[id])
    }
    return true
  }

  subscribe(ids) {
    if (ids.length <= 0) return
    console.info('Trying to subscribe to ' + JSON.stringify(ids))
    this.subscribeList = this.subscribeList.concat(ids).filter(unique)
    if (this.socket.readyState === 1) {
      // OPEN
      this.socket.send(
        JSON.stringify({ action: 'subscribe', ids: ids.filter(unique) }),
      )
    }
  }

  unsubscribe(ids) {
    if (ids.length <= 0) return

    this.subscribeList = this.subscribeList.filter((value,index) => {
      return ids.indexOf(value) == -1
    })

    if (this.socket.readyState === 1) {
      // OPEN
      this.socket.send(
        JSON.stringify({ action: 'unsubscribe', ids: ids.filter(unique) }),
      )
    }
  }
}
