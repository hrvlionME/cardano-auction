-- One-time MariaDB setup for the auction indexer.
--
--   sudo mariadb < sql/setup.sql
--
-- Run as root (the `sudo` above authenticates via unix_socket, so no MariaDB
-- password is needed). Everything the indexer stores is derived from the chain,
-- so this user needs no privileges outside its own database and the data it
-- holds is worth nothing to an attacker -- it is a cache of public information.
--
-- Change the password here and in off-chain/.env if you like; it guards a
-- rebuildable copy of public data on localhost.

CREATE DATABASE IF NOT EXISTS auction_indexer
  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

CREATE USER IF NOT EXISTS 'auction'@'localhost' IDENTIFIED BY 'auction';
CREATE USER IF NOT EXISTS 'auction'@'127.0.0.1' IDENTIFIED BY 'auction';

GRANT ALL PRIVILEGES ON auction_indexer.* TO 'auction'@'localhost';
GRANT ALL PRIVILEGES ON auction_indexer.* TO 'auction'@'127.0.0.1';

FLUSH PRIVILEGES;

SELECT 'auction_indexer ready' AS status;
