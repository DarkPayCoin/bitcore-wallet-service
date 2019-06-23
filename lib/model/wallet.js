'use strict';

var _ = require('lodash');
var util = require('util');
var log = require('npmlog');
var $ = require('preconditions').singleton();
var Uuid = require('uuid');
var ParticlBitcore = require('darkpay-bitcore-lib');

var Address = require('./address');
var Copayer = require('./copayer');
var AddressManager = require('./addressmanager');

var Common = require('../common');
var Constants = Common.Constants,
  Defaults = Common.Defaults,
  Utils = Common.Utils;

function Wallet() {};

Wallet.create = function(opts) {
  opts = opts || {};

  var x = new Wallet();

  $.shouldBeNumber(opts.m);
  $.shouldBeNumber(opts.n);
  $.checkArgument(Utils.checkValueInCollection(opts.coin, Constants.COINS));
  $.checkArgument(Utils.checkValueInCollection(opts.network, Constants.NETWORKS));

  x.version = '1.0.0';
  x.createdOn = Math.floor(Date.now() / 1000);
  x.id = opts.id || Uuid.v4();
  x.name = opts.name;
  x.m = opts.m;
  x.n = opts.n;
  x.singleAddress = !!opts.singleAddress;
  x.status = 'pending';
  x.publicKeyRing = [];
  x.addressIndex = 0;
  x.copayers = [];
  x.pubKey = opts.pubKey;
  x.coin = opts.coin;
  x.network = opts.network;
  x.derivationStrategy = opts.derivationStrategy || Constants.DERIVATION_STRATEGIES.BIP45;
  x.addressType = opts.addressType || Constants.SCRIPT_TYPES.P2SH;

  x.addressManager = AddressManager.create({
    derivationStrategy: x.derivationStrategy,
  });
  x.scanStatus = null;
  x.coldStakingSetup = {};

  return x;
};

Wallet.fromObj = function(obj) {
  var x = new Wallet();

  $.shouldBeNumber(obj.m);
  $.shouldBeNumber(obj.n);

  x.version = obj.version;
  x.createdOn = obj.createdOn;
  x.id = obj.id;
  x.name = obj.name;
  x.m = obj.m;
  x.n = obj.n;
  x.singleAddress = !!obj.singleAddress;
  x.status = obj.status;
  x.publicKeyRing = obj.publicKeyRing;
  x.copayers = _.map(obj.copayers, function(copayer) {
    return Copayer.fromObj(copayer);
  });
  x.pubKey = obj.pubKey;
  x.coin = obj.coin || Defaults.COIN;
  x.network = obj.network;
  x.derivationStrategy = obj.derivationStrategy || Constants.DERIVATION_STRATEGIES.BIP45;
  x.addressType = obj.addressType || Constants.SCRIPT_TYPES.P2SH;
  x.addressManager = AddressManager.fromObj(obj.addressManager);
  x.scanStatus = obj.scanStatus;
  x.coldStakingSetup = obj.coldStakingSetup;

  return x;
};

Wallet.prototype.toObject = function() {
  var x = _.cloneDeep(this);
  x.isShared = this.isShared();
  return x;
};

/**
 * Get the maximum allowed number of required copayers.
 * This is a limit imposed by the maximum allowed size of the scriptSig.
 * @param {number} totalCopayers - the total number of copayers
 * @return {number}
 */
Wallet.getMaxRequiredCopayers = function(totalCopayers) {
  return Wallet.COPAYER_PAIR_LIMITS[totalCopayers];
};

Wallet.verifyCopayerLimits = function(m, n) {
  return (n >= 1 && n <= 15) && (m >= 1 && m <= n);
};

Wallet.prototype.isShared = function() {
  return this.n > 1;
};


Wallet.prototype._updatePublicKeyRing = function() {
  this.publicKeyRing = _.map(this.copayers, function(copayer) {
    return _.pick(copayer, ['xPubKey', 'requestPubKey']);
  });
};

Wallet.prototype.addCopayer = function(copayer) {
  $.checkState(copayer.coin == this.coin);

  this.copayers.push(copayer);
  if (this.copayers.length < this.n) return;

  this.status = 'complete';
  this._updatePublicKeyRing();
};

Wallet.prototype.addCopayerRequestKey = function(copayerId, requestPubKey, signature, restrictions, name) {
  $.checkState(this.copayers.length == this.n);

  var c = this.getCopayer(copayerId);

  //new ones go first
  c.requestPubKeys.unshift({
    key: requestPubKey.toString(),
    signature: signature,
    selfSigned: true,
    restrictions: restrictions || {},
    name: name || null,
  });
};

Wallet.prototype.getCopayer = function(copayerId) {
  return _.find(this.copayers, {
    id: copayerId
  });
};

Wallet.prototype.isComplete = function() {
  return this.status == 'complete';
};

Wallet.prototype.isScanning = function() {
  return this.scanning;
};

Wallet.prototype.createAddress = function(isChange, sha256) {
  $.checkState(this.isComplete());

  var self = this;

  var path = this.addressManager.getNewAddressPath(isChange);
  log.verbose('Deriving addr:' + path);
  var address = Address.derive(self.id, this.addressType, this.publicKeyRing, path, this.m, this.coin, this.network, isChange, sha256);
  return address;
};

Wallet.prototype.createAddresses = function(isChange) {
  $.checkState(this.isComplete());

  var self = this,
      addresses = [];

  var path = this.addressManager.getNewAddressPath(isChange);
  log.verbose('Deriving addr:' + path);

  addresses.push(Address.derive(self.id, this.addressType, this.publicKeyRing, path, this.m, this.coin, this.network, isChange));

  if (self.coin === 'darkpay' && !self.singleAddress) {
    addresses.push(Address.derive(self.id, this.addressType, this.publicKeyRing, path, this.m, this.coin, this.network, isChange, true));
  }
  
  return addresses;
};

Wallet.prototype.updateColdStakingSetup = function(coldStakingSetup) {
  var self = this;

  self.coldStakingSetup = coldStakingSetup;
};

Wallet.prototype.getColdStakingSetup = function() {
  var self = this;

  return self.coldStakingSetup;
};

Wallet.prototype.getColdStakingAddresses = function(spendAddress) {
  var self = this,
      addresses = {};

  if (self.coin !== 'darkpay' || _.isEmpty(self.coldStakingSetup)) {
    return addresses;
  }

  if (self.coldStakingSetup.staking_key.startsWith('dcs') ||
      self.coldStakingSetup.staking_key.startsWith('tdcs')) {

    if (!self.coldStakingSetup.spend_address) {
      self.coldStakingSetup.spend_address = spendAddress ? spendAddress : self.createAddress(true, true);
    }

    addresses['staking_address'] = self.coldStakingSetup.staking_key;
    addresses['spend_address'] = self.coldStakingSetup.spend_address;
  } else {
    const xPub = ParticlBitcore.HDPublicKey(self.coldStakingSetup.staking_key);

    if (!self.coldStakingSetup.address_index) {
      self.coldStakingSetup['address_index'] = 0;
    }

    const coldStakingAddress = xPub
      .derive(self.coldStakingSetup.address_index++)
      .publicKey.toAddress()
      .toString();

    addresses['staking_address'] = coldStakingAddress;
    addresses['spend_address'] = spendAddress ? spendAddress : self.createAddress(true, true);
  }

  return addresses;
};

module.exports = Wallet;
